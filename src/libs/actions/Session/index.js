import Onyx from 'react-native-onyx';
import _ from 'underscore';
import lodashGet from 'lodash/get';
import ONYXKEYS from '../../../ONYXKEYS';
import redirectToSignIn from '../SignInRedirect';
import CONFIG from '../../../CONFIG';
import Log from '../../Log';
import PushNotification from '../../Notification/PushNotification';
import Timing from '../Timing';
import CONST from '../../../CONST';
import * as Localize from '../../Localize';
import Timers from '../../Timers';
import * as Pusher from '../../Pusher/pusher';
import * as Authentication from '../../Authentication';
import * as Welcome from '../Welcome';
import * as API from '../../API';
import * as NetworkStore from '../../Network/NetworkStore';
import DateUtils from '../../DateUtils';

let credentials = {};
Onyx.connect({
    key: ONYXKEYS.CREDENTIALS,
    callback: val => credentials = val || {},
});

/**
 * Manage push notification subscriptions on sign-in/sign-out
 */
let previousAccountID = '';
Onyx.connect({
    key: ONYXKEYS.SESSION,
    callback: (session) => {
        const accountID = lodashGet(session, 'accountID');

        if (accountID && previousAccountID !== accountID) {
            PushNotification.register(accountID);
            previousAccountID = accountID;
        }

        if (!accountID && previousAccountID !== accountID) {
            PushNotification.deregister();
            PushNotification.clearNotifications();
            previousAccountID = accountID;
        }
    },
});

/**
 * Clears the Onyx store and redirects user to the sign in page
 */
function signOut() {
    Log.info('Flushing logs before signing out', true, {}, true);

    const optimisticData = [
        {
            onyxMethod: CONST.ONYX.METHOD.SET,
            key: ONYXKEYS.SESSION,
            value: null,
        },
        {
            onyxMethod: CONST.ONYX.METHOD.SET,
            key: ONYXKEYS.CREDENTIALS,
            value: {},
        },
    ];
    API.write('LogOut', {
        // Send current authToken because we will immediately clear it once triggering this command
        authToken: NetworkStore.getAuthToken(),
        partnerUserID: lodashGet(credentials, 'autoGeneratedLogin', ''),
        partnerName: CONFIG.EXPENSIFY.PARTNER_NAME,
        partnerPassword: CONFIG.EXPENSIFY.PARTNER_PASSWORD,
        shouldRetry: false,
    }, {optimisticData});

    Timing.clearData();
}

function signOutAndRedirectToSignIn() {
    signOut();
    redirectToSignIn();
    Log.info('Redirecting to Sign In because signOut() was called');
}

/**
 * Resend the validation link to the user that is validating their account
 *
 * @param {String} [login]
 */
function resendValidationLink(login = credentials.login) {
    const optimisticData = [{
        onyxMethod: CONST.ONYX.METHOD.MERGE,
        key: ONYXKEYS.ACCOUNT,
        value: {
            isLoading: true,
            errors: null,
            message: null,
        },
    }];
    const successData = [{
        onyxMethod: CONST.ONYX.METHOD.MERGE,
        key: ONYXKEYS.ACCOUNT,
        value: {
            isLoading: false,
            message: Localize.translateLocal('resendValidationForm.linkHasBeenResent'),
        },
    }];
    const failureData = [{
        onyxMethod: CONST.ONYX.METHOD.MERGE,
        key: ONYXKEYS.ACCOUNT,
        value: {
            isLoading: false,
            message: null,
        },
    }];

    API.write('RequestAccountValidationLink', {email: login}, {optimisticData, successData, failureData});
}

/**
 * Checks the API to see if an account exists for the given login
 *
 * @param {String} login
 */
function beginSignIn(login) {
    const optimisticData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
            },
        },
    ];

    const successData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                errors: {
                    [DateUtils.getMicroseconds()]: Localize.translateLocal('loginForm.cannotGetAccountDetails'),
                },
            },
        },
    ];

    API.read('BeginSignIn', {email: login}, {optimisticData, successData, failureData});
}

/**
 * Will create a temporary login for the user in the passed authenticate response which is used when
 * re-authenticating after an authToken expires.
 *
 * @param {String} email
 * @param {String} authToken
 */
function signInWithShortLivedAuthToken(email, authToken) {
    const optimisticData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
            },
        },
    ];

    const successData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    // If the user is transitioning to newDot from a different account on oldDot the credentials may be tied to
    // the old account. If so, should not pass the auto-generated login as it is not tied to the account being signed in
    const oldPartnerUserID = credentials.login === email ? credentials.autoGeneratedLogin : '';
    API.write('SignInWithShortLivedAuthToken', {authToken, oldPartnerUserID}, {optimisticData, successData, failureData});
}

/**
 * Sign the user into the application. This will first authenticate their account
 * then it will create a temporary login for them which is used when re-authenticating
 * after an authToken expires.
 *
 * @param {String} password
 * @param {String} [twoFactorAuthCode]
 */
function signIn(password, twoFactorAuthCode) {
    const optimisticData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                ...CONST.DEFAULT_ACCOUNT_DATA,
                isLoading: true,
            },
        },
    ];

    const successData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    const failureData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    API.write('SigninUser', {email: credentials.login, password, twoFactorAuthCode}, {optimisticData, successData, failureData});
}

/**
 * User forgot the password so let's send them the link to reset their password
 */
function resetPassword() {
    API.write('RequestPasswordReset', {
        email: credentials.login,
    },
    {
        optimisticData: [
            {
                onyxMethod: CONST.ONYX.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    errors: null,
                    forgotPassword: true,
                    message: null,
                },
            },
        ],
    });
}

function resendResetPassword() {
    API.write('ResendRequestPasswordReset', {
        email: credentials.login,
    },
    {
        optimisticData: [
            {
                onyxMethod: CONST.ONYX.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    isLoading: true,
                    forgotPassword: true,
                    message: null,
                    errors: null,
                },
            },
        ],
        successData: [
            {
                onyxMethod: CONST.ONYX.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    isLoading: false,
                    message: Localize.translateLocal('resendValidationForm.linkHasBeenResent'),
                },
            },
        ],
        failureData: [
            {
                onyxMethod: CONST.ONYX.METHOD.MERGE,
                key: ONYXKEYS.ACCOUNT,
                value: {
                    isLoading: false,
                },
            },
        ],
    });
}

function invalidateCredentials() {
    Onyx.merge(ONYXKEYS.CREDENTIALS, {autoGeneratedLogin: '', autoGeneratedPassword: ''});
}

function invalidateAuthToken() {
    NetworkStore.setAuthToken('pizza');
    Onyx.merge(ONYXKEYS.SESSION, {authToken: 'pizza'});
}

/**
 * Clear the credentials and partial sign in session so the user can taken back to first Login step
 */
function clearSignInData() {
    Onyx.multiSet({
        [ONYXKEYS.ACCOUNT]: null,
        [ONYXKEYS.CREDENTIALS]: {},
    });
}

/**
 * Put any logic that needs to run when we are signed out here. This can be triggered when the current tab or another tab signs out.
 */
function cleanupSession() {
    Pusher.disconnect();
    Timers.clearAll();
    Welcome.resetReadyCheck();
}

function clearAccountMessages() {
    Onyx.merge(ONYXKEYS.ACCOUNT, {
        success: '',
        errors: null,
        message: null,
        isLoading: false,
    });
}

/**
 * Updates a password and authenticates them
 * @param {Number} accountID
 * @param {String} validateCode
 * @param {String} password
 */
function updatePasswordAndSignin(accountID, validateCode, password) {
    const optimisticData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: true,
                errors: null,
            },
        },
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.SESSION,
            value: {
                errors: null,
            },
        },
    ];

    const successData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
                errors: null,
            },
        },
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.SESSION,
            value: {
                errors: null,
            },
        },
    ];

    const failureData = [
        {
            onyxMethod: CONST.ONYX.METHOD.MERGE,
            key: ONYXKEYS.ACCOUNT,
            value: {
                isLoading: false,
            },
        },
    ];

    API.write('UpdatePasswordAndSignin', {
        accountID, validateCode, password,
    }, {optimisticData, successData, failureData});
}

// It's necessary to throttle requests to reauthenticate since calling this multiple times will cause Pusher to
// reconnect each time when we only need to reconnect once. This way, if an authToken is expired and we try to
// subscribe to a bunch of channels at once we will only reauthenticate and force reconnect Pusher once.
const reauthenticatePusher = _.throttle(() => {
    Log.info('[Pusher] Re-authenticating and then reconnecting');
    Authentication.reauthenticate('AuthenticatePusher')
        .then(Pusher.reconnect)
        .catch(() => {
            console.debug(
                '[PusherConnectionManager]',
                'Unable to re-authenticate Pusher because we are offline.',
            );
        });
}, 5000, {trailing: false});

/**
 * @param {String} socketID
 * @param {String} channelName
 * @param {Function} callback
 */
function authenticatePusher(socketID, channelName, callback) {
    Log.info('[PusherAuthorizer] Attempting to authorize Pusher', false, {channelName});

    // We use makeRequestWithSideEffects here because we need to authorize to Pusher (an external service) each time a user connects to any channel.
    // eslint-disable-next-line rulesdir/no-api-side-effects-method
    API.makeRequestWithSideEffects('AuthenticatePusher', {
        socket_id: socketID,
        channel_name: channelName,
        shouldRetry: false,
        forceNetworkRequest: true,
    }).then((response) => {
        if (response.jsonCode === CONST.JSON_CODE.NOT_AUTHENTICATED) {
            Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher because authToken is expired');
            callback(new Error('Pusher failed to authenticate because authToken is expired'), {auth: ''});

            // Attempt to refresh the authToken then reconnect to Pusher
            reauthenticatePusher();
            return;
        }

        if (response.jsonCode !== CONST.JSON_CODE.SUCCESS) {
            Log.hmmm('[PusherAuthorizer] Unable to authenticate Pusher for reason other than expired session');
            callback(new Error(`Pusher failed to authenticate because code: ${response.jsonCode} message: ${response.message}`), {auth: ''});
            return;
        }

        Log.info(
            '[PusherAuthorizer] Pusher authenticated successfully',
            false,
            {channelName},
        );
        callback(null, response);
    }).catch((error) => {
        Log.hmmm('[PusherAuthorizer] Unhandled error: ', {channelName, error});
        callback(new Error('AuthenticatePusher request failed'), {auth: ''});
    });
}

export {
    beginSignIn,
    updatePasswordAndSignin,
    signIn,
    signInWithShortLivedAuthToken,
    cleanupSession,
    signOut,
    signOutAndRedirectToSignIn,
    resendValidationLink,
    resetPassword,
    resendResetPassword,
    clearSignInData,
    clearAccountMessages,
    authenticatePusher,
    reauthenticatePusher,
    invalidateCredentials,
    invalidateAuthToken,
};
