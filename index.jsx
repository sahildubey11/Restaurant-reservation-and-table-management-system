import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, collection, onSnapshot, query, addDoc, updateDoc, doc, setDoc, getDocs
} from 'firebase/firestore';
import { Loader2, Calendar, ClipboardList, Utensils, Users, CheckCircle, Clock, X, Edit, PlusCircle, Maximize, CircleDashed, LogIn, LogOut, User, DollarSign, Briefcase } from 'lucide-react';

// --- Configuration Constants ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Manager access credentials for demo purposes only.
const MANAGER_EMAIL = "manager@resypro.com";
const MANAGER_PASS = "password123";
const MANAGER_UID_PROXY = "manager_access_uid_98765";
const BASE_COLLECTION_PATH = `/artifacts/${appId}/public/data`;

// Helper function for robust database interaction with retries
const withExponentialBackoff = async (asyncFunction, maxRetries = 5) => {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await asyncFunction();
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
        }
    }
};

// --- CUSTOM HOOKS FOR MODULARITY AND SIMPLICITY ---

// 1. Handles all Firebase initialization and user authentication state
const useFirebaseApp = () => {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [userEmail, setUserEmail] = useState(null);
    const [userRole, setUserRole] = useState('unauthenticated');
    const [isAuthReady, setIsAuthReady] = useState(false);

    useEffect(() => {
        if (Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase config is missing.");
            return;
        }

        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const firebaseAuth = getAuth(app);

        setDb(firestore);
        setAuth(firebaseAuth);

        // Listener to determine user status and role after auth changes
        const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
            if (!user) {
                // Ensure a base user session exists (anonymous or via token)
                await withExponentialBackoff(async () => {
                    if (initialAuthToken) {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                });
            }

            const currentUid = firebaseAuth.currentUser?.uid || 'anonymous';
            const currentEmail = firebaseAuth.currentUser?.email || null;
            setUserId(currentUid);
            setUserEmail(currentEmail);

            // Determine role based on ID/Email
            if (currentUid === MANAGER_UID_PROXY) {
                setUserRole('manager');
            } else if (currentEmail) {
                setUserRole('customer');
            } else {
                setUserRole('unauthenticated');
            }

            setIsAuthReady(true);
        });

        return () => unsubscribe();
    }, []);

    const handleAuthAction = useCallback(async (action, email, password) => {
        if (!auth) return { success: false, message: "Authentication service not ready." };

        try {
            if (action === 'signup') {
                await createUserWithEmailAndPassword(auth, email, password);
            } else if (action === 'signin') {
                await signInWithEmailAndPassword(auth, email, password);
            } else if (action === 'manager_login') {
                // Manager proxy logic
                if (email === MANAGER_EMAIL && password === MANAGER_PASS) {
                    setUserId(MANAGER_UID_PROXY);
                    setUserRole('manager');
                    setUserEmail(MANAGER_EMAIL);
                    return { success: true, message: "Manager logged in successfully." };
                } else {
                    return { success: false, message: "Invalid manager credentials." };
                }
            }
            return { success: true, message: `Welcome ${email}!` };
        } catch (error) {
            let errorMessage = "Authentication failed.";
            if (error.code === 'auth/operation-not-allowed') {
                errorMessage = "FIREBASE CONFIGURATION ERROR: Email/Password authentication is not enabled in your Firebase project console. Please enable it in the Authentication settings.";
            } else if (error.code === 'auth/email-already-in-use') {
                errorMessage = "This email is already registered. Please sign in.";
            } else if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                errorMessage = "Invalid email or password.";
            } else if (error.code === 'auth/weak-password') {
                errorMessage = "Password must be at least 6 characters.";
            } else {
                console.error("Auth Error:", error);
            }
            return { success: false, message: errorMessage };
        }
    }, [auth]);

    const handleLogout = useCallback(async () => {
        if (!auth) return;
        try {
            await signOut(auth);
            await signInAnonymously(auth);
            setUserRole('unauthenticated');
        } catch (error) {
            console.error("Logout failed:", error);
        }
    }, [auth]);

    return { db, auth, userId, userEmail, userRole, isAuthReady, handleAuthAction, handleLogout };
};

// 2. Handles all real-time data fetching and core reservation business logic
const useReservationLogic = (db, auth, isAuthReady) => {
    const [tables, setTables] = useState([]);
    const [reservations, setReservations] = useState([]);

    // --- Core Database Utility ---
    const updateTableStatus = useCallback(async (tableId, newStatus, reservationId = null) => {
        if (!db) return;
        const tableDocRef = doc(db, `${BASE_COLLECTION_PATH}/tables/${tableId}`);

        try {
            await withExponentialBackoff(() =>
                updateDoc(tableDocRef, {
                    status: newStatus,
                    reservationId: reservationId,
                })
            );

            // If the table is being cleared (available), mark the reservation as fulfilled
            if (newStatus === 'available' && reservationId) {
                const resDocRef = doc(db, `${BASE_COLLECTION_PATH}/reservations/${reservationId}`);
                await withExponentialBackoff(() => setDoc(resDocRef, { status: 'fulfilled', fulfilledAt: new Date().toISOString() }, { merge: true }));
            }
        } catch (error) {
            console.error("Error updating table status:", error);
        }
    }, [db]);

    // Finds the smallest available table that fits the party size (Optimization & Conflict Detection)
    const findBestFitTable = useCallback((partySize, tableToExclude = null) => {
        return tables
            .filter(t =>
                // Table must be available OR it must be the table being currently modified
                (t.status === 'available' || t.id === tableToExclude) &&
                t.capacity >= partySize
            )
            // Sort by capacity ascending and select the first one (best fit)
            .sort((a, b) => a.capacity - b.capacity)[0];
    }, [tables]);


    // --- Firestore Data Listeners and Initial Setup ---
    useEffect(() => {
        if (!isAuthReady || !db) return;

        const tablesCollectionRef = collection(db, `${BASE_COLLECTION_PATH}/tables`);
        const reservationsCollectionRef = collection(db, `${BASE_COLLECTION_PATH}/reservations`);

        // Setup Default Tables if the collection is empty
        const setupInitialData = async () => {
            const snapshot = await getDocs(tablesCollectionRef);
            if (snapshot.empty) {
                const defaultTables = [
                    { id: 'T1', capacity: 2, status: 'available', reservationId: null },
                    { id: 'T2', capacity: 4, status: 'available', reservationId: null },
                    { id: 'T3', capacity: 6, status: 'available', reservationId: null },
                    { id: 'B1', capacity: 8, status: 'available', reservationId: null },
                ];
                await Promise.all(defaultTables.map(t => setDoc(doc(tablesCollectionRef, t.id), t)));
            }
        };

        setupInitialData();

        // Real-Time Listener for Tables
        const unsubscribeTables = onSnapshot(query(tablesCollectionRef), (snapshot) => {
            const tablesData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTables(tablesData.sort((a, b) => a.id.localeCompare(b.id)));
        }, (error) => { console.error("Error listening to tables:", error); });

        // Real-Time Listener for Reservations
        const unsubscribeReservations = onSnapshot(query(reservationsCollectionRef), (snapshot) => {
            const reservationsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(res => res.status === 'pending' || res.status === 'confirmed' || res.status === 'seated');
            setReservations(reservationsData.sort((a, b) => new Date(a.time) - new Date(b.time)));
        }, (error) => { console.error("Error listening to reservations:", error); });

        return () => {
            unsubscribeTables();
            unsubscribeReservations();
        };

    }, [isAuthReady, db]);

    // --- Customer Reservation Actions ---

    // Creates a new reservation, finds the best fit table, and updates table status
    const handleNewReservation = useCallback(async (reservationDetails) => {
        if (!db || !auth.currentUser) return { success: false, message: "Error: Database or Auth not ready." };

        const bestFitTable = findBestFitTable(reservationDetails.size);

        if (!bestFitTable) {
            return { success: false, message: "No suitable table found for that party size at the moment." };
        }

        const reservationsCollectionRef = collection(db, `${BASE_COLLECTION_PATH}/reservations`);
        const tableDocRef = doc(db, `${BASE_COLLECTION_PATH}/tables/${bestFitTable.id}`);

        try {
            // 1. Add reservation document
            const newResRef = await withExponentialBackoff(() =>
                addDoc(reservationsCollectionRef, {
                    ...reservationDetails,
                    tableId: bestFitTable.id,
                    status: 'pending',
                    customerUid: auth.currentUser?.uid,
                    createdAt: new Date().toISOString(),
                })
            );

            // 2. Update the table status to 'reserved'
            await withExponentialBackoff(() =>
                updateDoc(tableDocRef, {
                    status: 'reserved',
                    reservationId: newResRef.id,
                })
            );

            return { success: true, message: `Success! Table ${bestFitTable.id} reserved for ${reservationDetails.name}.`, resId: newResRef.id };

        } catch (error) {
            console.error("Error making reservation:", error);
            return { success: false, message: "An unexpected error occurred during reservation." };
        }
    }, [db, findBestFitTable, auth]);

    // Allows modification of booking details and handles table reassignment if needed
    const handleModifyReservation = useCallback(async (reservationId, originalTableId, newDetails) => {
        if (!db) return { success: false, message: "Error: Database not ready." };

        const originalTable = tables.find(t => t.id === originalTableId);
        if (!originalTable) { return { success: false, message: "Original table data not found." }; }

        let targetTable = originalTable;
        let requiresTableChange = false;

        // Optimization: Find the smallest possible table for the new party size
        const bestFitTableCandidate = findBestFitTable(newDetails.size, originalTableId);

        // Logic to determine if table reassignment is necessary:
        if (newDetails.size > originalTable.capacity) {
            // Party size increased and current table is too small
            if (!bestFitTableCandidate) { return { success: false, message: "Cannot modify: No larger tables available for the new party size." }; }
            targetTable = bestFitTableCandidate;
            requiresTableChange = true;
        } else if (newDetails.size < originalTable.capacity) {
            // Party size decreased: Check if a more optimal (smaller capacity) table is available
            if (bestFitTableCandidate && bestFitTableCandidate.capacity < originalTable.capacity) {
                targetTable = bestFitTableCandidate;
                requiresTableChange = true;
            }
        }

        const resDocRef = doc(db, `${BASE_COLLECTION_PATH}/reservations/${reservationId}`);

        try {
            // 1. Update reservation details
            await withExponentialBackoff(() =>
                updateDoc(resDocRef, {
                    ...newDetails,
                    tableId: targetTable.id,
                    modifiedAt: new Date().toISOString(),
                })
            );

            // 2. Update table statuses if the table assignment changed
            if (requiresTableChange) {
                // Free up the original table
                await updateTableStatus(originalTableId, 'available', null);

                // Reserve the new, more appropriate table
                await updateTableStatus(targetTable.id, 'reserved', reservationId);
            }

            return { success: true, message: `Success! Reservation modified and assigned to Table ${targetTable.id}.` };

        } catch (error) {
            console.error("Error modifying reservation:", error);
            return { success: false, message: "An unexpected error occurred during modification." };
        }
    }, [db, tables, findBestFitTable, updateTableStatus]);

    // Cancels a reservation and frees up the associated table
    const handleCancelReservation = useCallback(async (reservationId, tableId) => {
        if (!db) return { success: false, message: "Error: Database not ready." };

        const resDocRef = doc(db, `${BASE_COLLECTION_PATH}/reservations/${reservationId}`);
        const tableDocRef = doc(db, `${BASE_COLLECTION_PATH}/tables/${tableId}`);

        try {
            // 1. Mark reservation as cancelled
            await withExponentialBackoff(() =>
                updateDoc(resDocRef, { status: 'cancelled', cancelledAt: new Date().toISOString() })
            );

            // 2. Mark table as available
            await updateTableStatus(tableId, 'available', null);

            return { success: true, message: "Success! Reservation cancelled." };
        } catch (error) {
            console.error("Error cancelling reservation:", error);
            return { success: false, message: "An unexpected error occurred during cancellation." };
        }
    }, [db, updateTableStatus]);

    // Allows manager to add or update table configuration
    const handleAddOrUpdateTable = useCallback(async (tableId, capacity) => {
        if (!db) return { success: false, message: "Error: Database not ready." };

        const tableDocRef = doc(db, `${BASE_COLLECTION_PATH}/tables/${tableId.toUpperCase()}`);

        try {
            await withExponentialBackoff(() =>
                setDoc(tableDocRef, {
                    id: tableId.toUpperCase(),
                    capacity: capacity,
                    status: 'available',
                    reservationId: null
                }, { merge: true })
            );
            return { success: true, message: `Success! Table ${tableId.toUpperCase()} (Capacity ${capacity}) created/updated.` };
        } catch (error) {
            console.error("Error setting table:", error);
            return { success: false, message: "Error adding/updating table." };
        }
    }, [db]);


    return {
        tables,
        reservations,
        handleNewReservation,
        handleModifyReservation,
        handleCancelReservation,
        updateTableStatus,
        handleAddOrUpdateTable,
    };
};

// --- CUSTOM UI COMPONENTS ---

const AuthModal = ({ title, handleSubmit, isManager = false, initialEmail = '', initialPass = '', showBackButton = true }) => {
    const [email, setEmail] = useState(initialEmail);
    const [password, setPassword] = useState(initialPass);
    const [isSignUp, setIsSignUp] = useState(false);
    const [authMessage, setAuthMessage] = useState('');
    const [isAuthenticating, setIsAuthenticating] = useState(false);

    const onSubmit = async (e) => {
        e.preventDefault();
        setIsAuthenticating(true);
        setAuthMessage('');

        const action = isManager ? 'manager_login' : (isSignUp ? 'signup' : 'signin');
        const result = await handleSubmit(action, email, password);

        setAuthMessage(result.message);
        setIsAuthenticating(false);

        if (result.success) {
            // Clear message after a brief pause for a successful transition
            setTimeout(() => setAuthMessage(''), 2000);
        }
    };

    const isLogin = !isSignUp;
    const actionText = isLogin ? 'Sign In' : 'Sign Up';

    return (
        <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md mx-auto border-t-8 border-red-700">
            <h2 className="text-3xl font-bold text-gray-800 mb-6 flex items-center">
                {isManager ? <Briefcase className="mr-3 text-red-700" size={24} /> : <User className="mr-3 text-red-700" size={24} />}
                {title}
            </h2>
            <form onSubmit={onSubmit} className="space-y-4">
                <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Email</label>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-xl border-gray-300 shadow-sm p-3 bg-gray-50 focus:border-red-500 focus:ring-red-500"
                        required
                        disabled={isAuthenticating}
                    />
                </div>
                <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-1">Password</label>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-xl border-gray-300 shadow-sm p-3 bg-gray-50 focus:border-red-500 focus:ring-red-500"
                        required
                        disabled={isAuthenticating}
                    />
                </div>
                <button
                    type="submit"
                    disabled={isAuthenticating}
                    className={`w-full flex justify-center items-center py-3 px-4 rounded-xl shadow-lg text-lg font-bold text-white transition duration-200 transform ${
                        isAuthenticating
                            ? 'bg-red-400 cursor-not-allowed'
                            : 'bg-red-700 hover:bg-red-800 hover:scale-[1.01]'
                    }`}
                >
                    {isAuthenticating ? (
                        <>
                            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                            {actionText} In...
                        </>
                    ) : (
                        actionText
                    )}
                </button>
            </form>
            {authMessage && (
                <div className={`mt-4 p-3 rounded-lg text-sm font-medium ${authMessage.includes('Success') || authMessage.includes('Welcome') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {authMessage}
                </div>
            )}
            {!isManager && (
                <div className="mt-4 text-center">
                    <button
                        onClick={() => setIsSignUp(prev => !prev)}
                        className="text-sm text-blue-600 hover:text-blue-800 transition font-medium"
                    >
                        {isSignUp ? 'Already have an account? Sign In.' : 'New user? Create an account.'}
                    </button>
                </div>
            )}
            {showBackButton && (
                <button
                    onClick={() => window.location.reload()} // Simple way to reset state to 'welcome' screen
                    className="w-full mt-4 text-center text-sm text-gray-500 hover:text-gray-700 transition font-medium"
                >
                    &larr; Back to Welcome Screen
                </button>
            )}
            {isManager && (
                <p className="mt-6 text-center text-xs text-gray-500">
                    Demo Credentials: {MANAGER_EMAIL} / {MANAGER_PASS}
                </p>
            )}
        </div>
    );
};


const WelcomeScreen = ({ setAppScreen }) => (
    <div className="bg-white p-8 md:p-12 rounded-3xl shadow-2xl w-full max-w-2xl mx-auto border-t-8 border-red-700 text-center">
        <h2 className="text-4xl font-extrabold text-gray-800 mb-4">Welcome to ResyPro</h2>
        <p className="text-lg text-gray-600 mb-10">Select your role to proceed to the reservation portal or the management dashboard.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <button
                onClick={() => setAppScreen('customer_auth')}
                className="flex flex-col items-center justify-center p-8 bg-red-50 border-2 border-red-200 rounded-2xl transition duration-300 transform hover:scale-[1.03] hover:shadow-xl group"
            >
                <DollarSign size={40} className="text-red-600 mb-3 group-hover:text-red-700 transition" />
                <span className="text-xl font-bold text-gray-800">Reserve a Table</span>
                <span className="text-sm text-gray-500 mt-1">Customer Sign In/Up Required</span>
            </button>

            <button
                onClick={() => setAppScreen('manager_login')}
                className="flex flex-col items-center justify-center p-8 bg-gray-50 border-2 border-gray-200 rounded-2xl transition duration-300 transform hover:scale-[1.03] hover:shadow-xl group"
            >
                <Briefcase size={40} className="text-gray-600 mb-3 group-hover:text-gray-800 transition" />
                <span className="text-xl font-bold text-gray-800">Manage Operations</span>
                <span className="text-sm text-gray-500 mt-1">Manager Sign In Required</span>
            </button>
        </div>
    </div>
);


// --- CORE APPLICATION COMPONENT ---

const App = () => {
    const { db, auth, userId, userEmail, userRole, isAuthReady, handleAuthAction, handleLogout } = useFirebaseApp();
    const {
        tables,
        reservations,
        handleNewReservation,
        handleModifyReservation,
        handleCancelReservation,
        updateTableStatus,
        handleAddOrUpdateTable,
    } = useReservationLogic(db, auth, isAuthReady);

    const [appScreen, setAppScreen] = useState('welcome');
    const [userReservationId, setUserReservationId] = useState(null); // Tracks active customer reservation
    const [loading, setLoading] = useState(true);

    // Determines the currently active reservation for the logged-in user
    const userReservation = useMemo(() => {
        // Find the most recent active reservation linked to the current user ID
        const activeRes = reservations.find(res => res.customerUid === userId && (res.status === 'pending' || res.status === 'confirmed'));
        if (activeRes) {
            setUserReservationId(activeRes.id);
            return activeRes;
        }
        return null;
    }, [reservations, userId]);


    // Loading state sync
    useEffect(() => {
        if (isAuthReady) {
            setLoading(false);
        }
    }, [isAuthReady]);

    // Auto-transition after successful login
    useEffect(() => {
        if (userRole === 'customer' && appScreen === 'customer_auth') {
            setAppScreen('customer_view');
        } else if (userRole === 'manager' && appScreen === 'manager_login') {
            setAppScreen('manager_dashboard');
        } else if (userRole === 'unauthenticated' && appScreen !== 'welcome' && appScreen !== 'customer_auth' && appScreen !== 'manager_login') {
            // If user logs out, go back to welcome
            setAppScreen('welcome');
        }
    }, [userRole, appScreen]);


    // --- SCREEN IMPLEMENTATIONS (Rendered inside <main>) ---

    const CustomerView = () => {
        const [name, setName] = useState(userReservation?.name || userEmail || '');
        const [size, setSize] = useState(userReservation?.size || 2);
        const [time, setTime] = useState(userReservation?.time || new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 19, 0).toISOString().slice(0, 16));
        const [message, setMessage] = useState('');
        const [isSubmitting, setIsSubmitting] = useState(false);
        const [isModifying, setIsModifying] = useState(!!userReservation);
        const [showCancelPrompt, setShowCancelPrompt] = useState(false);

        // Sync form state when userReservation changes or modification mode is toggled
        useEffect(() => {
            if (userReservation) {
                setName(userReservation.name);
                setSize(userReservation.size);
                setTime(userReservation.time);
                setIsModifying(false); // Default to viewing if reservation exists
            }
        }, [userReservation]);

        const handleBooking = async (e) => {
            e.preventDefault();
            if (!name || !size || !time) { setMessage("Please fill in all fields."); return; }
            setIsSubmitting(true); setMessage('');

            const result = await handleNewReservation({ name, size, time });
            setMessage(result.message);
            setIsSubmitting(false);

            if (result.success) { setUserReservationId(result.resId); }
        };

        const handleModification = async (e) => {
            e.preventDefault();
            if (!userReservation) return;

            setIsSubmitting(true); setMessage('');

            const result = await handleModifyReservation(userReservation.id, userReservation.tableId, { name, size, time });
            setMessage(result.message);
            setIsSubmitting(false);

            if (result.success) { setIsModifying(false); }
        };

        const performCancellation = async () => {
            if (!userReservation) return;
            setShowCancelPrompt(false);
            setIsSubmitting(true); setMessage('');

            const result = await handleCancelReservation(userReservation.id, userReservation.tableId);
            setMessage(result.message);
            setIsSubmitting(false);

            if (result.success) { setUserReservationId(null); }
        };

        const minTime = new Date().toISOString().slice(0, 16);

        // Confirmation/Modification View
        if (userReservation && !isModifying) {
            const reservationTime = new Date(userReservation.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

            return (
                <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-lg mx-auto border-t-8 border-red-700">
                    <h2 className="text-3xl font-bold text-gray-800 mb-6 flex items-center">
                        <CheckCircle className="mr-3 text-green-600" size={28} />
                        Your Reservation
                    </h2>
                    <div className="space-y-4 p-4 border rounded-xl bg-gray-50 text-gray-700">
                        <p className="flex justify-between items-center text-lg"><span className="font-semibold">Name:</span> <span>{userReservation.name}</span></p>
                        <p className="flex justify-between items-center text-lg"><span className="font-semibold">Party Size:</span> <span>{userReservation.size} Guests</span></p>
                        <p className="flex justify-between items-center text-lg"><span className="font-semibold">Time:</span> <span>{reservationTime}</span></p>
                        <p className="flex justify-between items-center text-lg bg-red-50 p-2 rounded-lg">
                            <span className="font-semibold text-red-700">Assigned Table:</span>
                            <span className="font-extrabold text-red-700">{userReservation.tableId}</span>
                        </p>
                    </div>

                    <div className="mt-6 flex space-x-3">
                        <button
                            onClick={() => setIsModifying(true)}
                            className="flex-1 flex justify-center items-center py-3 px-4 rounded-xl shadow-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition transform hover:scale-[1.01]"
                        >
                            <Edit className="mr-2 h-4 w-4" /> Modify Booking
                        </button>
                        <button
                            onClick={() => setShowCancelPrompt(true)}
                            disabled={isSubmitting}
                            className="flex-1 flex justify-center items-center py-3 px-4 rounded-xl shadow-lg text-sm font-semibold text-gray-700 bg-gray-200 hover:bg-gray-300 transition disabled:opacity-50"
                        >
                            <X className="mr-2 h-4 w-4" /> Cancel Reservation
                        </button>
                    </div>
                    {showCancelPrompt && (
                        <div className="mt-4 p-4 bg-red-100 rounded-xl flex justify-between items-center">
                            <p className="text-red-700 font-semibold text-sm">Confirm cancellation?</p>
                            <div className='flex space-x-2'>
                                <button onClick={() => setShowCancelPrompt(false)} className='text-xs font-semibold text-gray-600 px-2 py-1 rounded-lg bg-white hover:bg-gray-50'>No</button>
                                <button onClick={performCancellation} className='text-xs font-semibold text-white px-2 py-1 rounded-lg bg-red-600 hover:bg-red-700'>Yes, Cancel</button>
                            </div>
                        </div>
                    )}
                    {message && <div className={`mt-4 p-3 rounded-lg text-sm font-medium bg-green-100 text-green-700`}>{message}</div>}
                    <p className="mt-4 text-xs text-gray-500 italic text-center">
                        Reservation is tied to your account: {userEmail}.
                    </p>
                </div>
            );
        }

        // Reservation/Modification Form View
        return (
            <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-lg mx-auto border-t-4 border-red-600">
                <h2 className="text-3xl font-bold text-gray-800 mb-6 flex items-center">
                    <Calendar className="mr-3 text-red-600" size={24} />
                    {isModifying ? 'Modify Booking Details' : 'New Table Reservation'}
                </h2>
                <form onSubmit={isModifying ? handleModification : handleBooking} className="space-y-5">
                    {/* Input fields for Name, Size, Time... */}
                    <div><label htmlFor="name" className="block text-sm font-semibold text-gray-700 mb-1">Name</label><input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-xl border-gray-300 shadow-sm p-3 bg-gray-50 focus:border-red-500 focus:ring-red-500" placeholder="Full name" required/></div>
                    <div><label htmlFor="size" className="block text-sm font-semibold text-gray-700 mb-1">Party Size (1-8)</label><input id="size" type="number" value={size} onChange={(e) => setSize(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))} min="1" max="8" className="mt-1 block w-full rounded-xl border-gray-300 shadow-sm p-3 bg-gray-50 focus:border-red-500 focus:ring-red-500" required/></div>
                    <div><label htmlFor="time" className="block text-sm font-semibold text-gray-700 mb-1">Reservation Time</label><input id="time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} min={minTime} className="mt-1 block w-full rounded-xl border-gray-300 shadow-sm p-3 bg-gray-50 focus:border-red-500 focus:ring-red-500" required/></div>

                    <button
                        type="submit"
                        disabled={isSubmitting}
                        className={`w-full flex justify-center items-center py-3 px-4 rounded-xl shadow-lg text-lg font-bold text-white transition duration-200 transform ${
                            isSubmitting ? 'bg-red-400 cursor-not-allowed' : 'bg-red-700 hover:bg-red-800 hover:scale-[1.01]'
                        }`}
                    >
                        {isSubmitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : (isModifying ? 'Save Modification' : 'Confirm Reservation')}
                    </button>
                    {isModifying && (
                         <button type="button" onClick={() => setIsModifying(false)} className="w-full text-center py-2 text-sm text-gray-500 hover:text-gray-700 transition font-medium">
                            Cancel Modification
                        </button>
                    )}
                </form>
                {message && (<div className={`mt-4 p-3 rounded-lg text-sm font-medium ${message.includes('Success') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{message}</div>)}
            </div>
        );
    };

    const TableLayoutManager = ({ handleAddOrUpdateTable }) => {
        const [tableId, setTableId] = useState('');
        const [capacity, setCapacity] = useState(4);
        const [layoutMessage, setLayoutMessage] = useState('');

        const handleUpdate = async (e) => {
            e.preventDefault();
            if (!tableId) { setLayoutMessage("Table ID is required."); return; }

            const result = await handleAddOrUpdateTable(tableId, capacity);
            setLayoutMessage(result.message);
            if (result.success) {
                setTableId('');
                setCapacity(4);
            }
        };

        return (
            <div className="p-5 bg-white rounded-xl shadow-lg border border-gray-100 mt-6">
                <h4 className="text-xl font-bold mb-4 flex items-center text-gray-800">
                    <Maximize size={18} className="mr-2 text-red-600" />
                    Optimize Seating Capacity
                </h4>
                <form onSubmit={handleUpdate} className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3 items-end">
                    <div className="flex-1 w-full">
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Table ID (e.g., T5, B2)</label>
                        <input type="text" value={tableId} onChange={(e) => setTableId(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))} className="w-full p-2 border rounded-lg bg-gray-50" placeholder="T5" required/>
                    </div>
                    <div className="w-full sm:w-24">
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Capacity</label>
                        <input type="number" value={capacity} onChange={(e) => setCapacity(Math.max(1, parseInt(e.target.value) || 1))} min="1" max="12" className="w-full p-2 border rounded-lg bg-gray-50" required/>
                    </div>
                    <button type="submit" className="w-full sm:w-auto p-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold flex items-center justify-center shadow-md">
                        <PlusCircle size={16} className="mr-1" /> Add/Update
                    </button>
                </form>
                {layoutMessage && <p className={`mt-2 text-sm font-medium ${layoutMessage.includes('Success') ? 'text-green-600' : 'text-red-600'}`}>{layoutMessage}</p>}
            </div>
        );
    };

    const TableManagerDashboard = () => {
        const getStatusClasses = (status) => {
            switch (status) {
                case 'available': return 'bg-green-50 border-green-500 text-green-800 shadow-lg hover:bg-green-100';
                case 'reserved': return 'bg-yellow-50 border-yellow-500 text-yellow-800 shadow-xl hover:bg-yellow-100';
                case 'seated': return 'bg-red-50 border-red-500 text-red-800 shadow-xl ring-2 ring-red-300 hover:bg-red-100';
                default: return 'bg-gray-100 border-gray-500 text-gray-700';
            }
        };

        const TableCard = ({ table }) => {
            const currentReservation = reservations.find(res => res.id === table.reservationId);
            const isReserved = table.status === 'reserved';
            const isSeated = table.status === 'seated';

            const handleStatusChange = (newStatus) => {
                const nextResId = newStatus === 'available' ? null : table.reservationId;
                updateTableStatus(table.id, newStatus, nextResId);
            };

            return (
                <div className={`p-5 rounded-2xl border-l-4 transition duration-200 ${getStatusClasses(table.status)}`}>
                    <div className="flex justify-between items-start mb-2">
                        <h3 className="text-3xl font-extrabold flex items-center">Table {table.id}</h3>
                        <div className="p-1 bg-white/70 rounded-full border border-gray-300 text-gray-700"><Users size={18} className="ml-1" /></div>
                    </div>

                    <p className="text-sm font-semibold mb-3 border-b border-dashed pb-2">Capacity: <span className='font-extrabold'>{table.capacity}</span></p>
                    <div className="text-sm font-medium">Status: <span className={`capitalize font-bold ${table.status === 'seated' ? 'text-red-700' : ''}`}>{table.status}</span></div>

                    {currentReservation && (
                        <div className="mt-4 p-3 bg-white rounded-xl shadow-md text-sm border-l-4 border-red-400">
                            <p className="font-semibold text-gray-800">{currentReservation.name}</p>
                            <p className="flex items-center text-xs mt-1 text-gray-600">
                                <Clock size={12} className="mr-1" />
                                {new Date(currentReservation.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({currentReservation.size} Guests)
                            </p>
                        </div>
                    )}

                    <div className="mt-4 flex flex-col space-y-2">
                        {isReserved && (
                            <button onClick={() => handleStatusChange('seated')} className="bg-red-700 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-red-800 transition shadow-md">
                                Mark Seated Now
                            </button>
                        )}
                        {isSeated && (
                            <button onClick={() => handleStatusChange('available', table.reservationId)} className="bg-gray-700 text-white py-2 px-3 rounded-lg text-sm font-medium hover:bg-gray-800 transition shadow-md">
                                Clear Table
                            </button>
                        )}
                        {!isReserved && !isSeated && (
                             <div className="flex items-center justify-center bg-gray-200 text-gray-600 py-2 px-3 rounded-lg text-sm font-medium">
                                <CheckCircle size={14} className="mr-2 text-green-600"/> Available
                            </div>
                        )}
                    </div>
                </div>
            );
        };

        const ReservationList = ({ reservations }) => (
            <div className="p-6 bg-white rounded-3xl shadow-2xl">
                <h3 className="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                    <ClipboardList className="mr-3 text-red-600" size={24} /> Upcoming Bookings ({reservations.filter(res => res.status === 'pending').length})
                </h3>
                <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                    {reservations.filter(res => res.status === 'pending').length === 0 ? (
                        <p className="text-gray-500 italic p-3 border rounded-xl bg-gray-50 flex items-center">
                             <CircleDashed size={16} className="mr-2"/> Nothing pending.
                        </p>
                    ) : (
                        reservations.filter(res => res.status === 'pending').map(res => {
                            const table = tables.find(t => t.id === res.tableId);
                            return (
                                <div key={res.id} className="p-4 border-l-4 border-yellow-500 bg-yellow-50 rounded-xl flex justify-between items-center transition hover:bg-yellow-100 shadow-sm">
                                    <div>
                                        <p className="font-bold text-gray-800">{res.name} ({res.size} P.)</p>
                                        <p className="text-xs text-gray-600 flex items-center mt-1">
                                            <Clock size={12} className="mr-1" />
                                            {new Date(res.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            {table && <span className="ml-3 font-medium text-red-600">Table {table.id}</span>}
                                        </p>
                                    </div>
                                    {table && table.status === 'reserved' && (
                                        <button onClick={() => updateTableStatus(table.id, 'seated', res.id)} className="text-white bg-red-600 hover:bg-red-700 text-xs px-3 py-1.5 rounded-full shadow transition font-semibold">
                                            Seat
                                        </button>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        );

        return (
            <div className="w-full">
                <h2 className="text-4xl font-extrabold text-gray-900 mb-8 flex items-center">
                    <Utensils className="mr-4 text-red-700" size={36} />
                    Operations Dashboard
                </h2>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2">
                        <h3 className="text-2xl font-bold mb-4 text-gray-800">Seating Chart (Live Status)</h3>
                        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
                            {tables.map(table => (<TableCard key={table.id} table={table} />))}
                        </div>
                        <TableLayoutManager handleAddOrUpdateTable={handleAddOrUpdateTable} />
                    </div>
                    <div className="lg:col-span-1">
                        <ReservationList reservations={reservations} />
                    </div>
                </div>
            </div>
        );
    };

    // --- MAIN RENDER LOGIC ---

    if (loading) {
        return (
            <div className="flex justify-center items-center h-screen bg-gray-50">
                <Loader2 className="h-10 w-10 text-red-600 animate-spin" />
                <p className="ml-3 text-lg font-medium text-gray-700">Setting up secure connection...</p>
            </div>
        );
    }

    const HeaderControls = () => {
        const isManager = userRole === 'manager';
        if (userRole === 'customer' || isManager) {
            return (
                <div className='flex items-center space-x-3'>
                    <span className='text-sm font-semibold text-gray-700 hidden sm:block'>{isManager ? 'Manager' : 'Customer'}: {userEmail}</span>
                    <button onClick={handleLogout} className={`flex items-center py-2 px-4 rounded-xl font-semibold transition ${isManager ? 'bg-red-700 text-white hover:bg-red-800' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} shadow-md`}>
                        <LogOut size={16} className="mr-2" /> Logout
                    </button>
                </div>
            );
        }
        return (
             <button onClick={() => setAppScreen('manager_login')} className="flex items-center py-2 px-4 rounded-xl font-semibold transition bg-gray-200 text-gray-700 hover:bg-gray-300 shadow-md">
                <LogIn size={16} className="mr-2" /> Manager Login
            </button>
        );
    };

    const AppContent = () => {
        switch (appScreen) {
            case 'welcome':
                return <WelcomeScreen setAppScreen={setAppScreen} />;
            case 'customer_auth':
                return <AuthModal title="Customer Account" handleSubmit={handleAuthAction} showBackButton={true} />;
            case 'customer_view':
                return <CustomerView />;
            case 'manager_login':
                return <AuthModal title="Manager Sign In" handleSubmit={handleAuthAction} isManager={true} initialEmail={MANAGER_EMAIL} initialPass={MANAGER_PASS} showBackButton={true} />;
            case 'manager_dashboard':
                return userRole === 'manager' ? <TableManagerDashboard /> : <WelcomeScreen setAppScreen={setAppScreen} />;
            default:
                return <WelcomeScreen setAppScreen={setAppScreen} />;
        }
    };

    return (
        <div className="min-h-screen bg-gray-100 p-4 sm:p-10 font-sans">
            <header className="mb-10 bg-white p-6 rounded-3xl shadow-2xl">
                <div className='flex justify-between items-center'>
                    <h1 className="text-4xl sm:text-5xl font-extrabold text-red-700 tracking-tight">
                        ResyPro
                        <span className="text-xl text-gray-400 font-light ml-3 hidden sm:inline">Table Management Suite</span>
                    </h1>
                    <HeaderControls />
                </div>
            </header>

            <main className="py-4">
                <AppContent />
            </main>

            <footer className="mt-16 text-center text-gray-500 text-sm border-t pt-6">
                <p>Full-Stack Demo built with React and real-time Firebase Firestore.</p>
            </footer>
        </div>
    );
};

export default App;
