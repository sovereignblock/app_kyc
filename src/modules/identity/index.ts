import { Crypt } from 'hybrid-crypto-js';
import { isEqual } from 'lodash';
import type { AxiosResponse } from 'axios';

import appConfig from '@@Config/app';
import { request } from '@@Modules/nerves';
import { generateKeyPair, uniqueHashFromIdentity } from '@@Modules/crypto';
import { makeInfoProps } from '@@Modules/info';
import { getJob, decryptJob, getJobList, postJob } from '@@Modules/job';
import { getEncryptedKeypair, decryptKeypair, postEncryptedKeypair } from '@@Modules/user';
import type { InfoType } from '@@Modules/info';
import type { RequestReponseObject } from '@@Modules/nerves';
import type { User } from '@@Modules/user';
import type { UsersType } from '@@Modules/user';
import type { Keypair, Encrypted } from '@@Modules/crypto';

/**
 * Array of two numbers representing the number of confirmations for an identity. Confirmed / Total.
 */
export type Confirmations = [ number, number ];

/**
 * Based on Chaincode Contracts settings and identity confirmations, an identity will be KYC (verified) or not.
 */
export type KYC = boolean;

/**
 * Standardized national identity.
 */
export type IdentityType = {
    firstname: string;
    lastname: string;
    nation: string;
    nationalId: string;
    birthdate: string;
    documentation: string;
    uniqueHash: string;
}

/**
 * KYC properties, to associate with a standard identity.
 */
export type WithKYC = {
    confirmations: Confirmations;
    kyc: KYC;
}

/**
 * Standard identity with KYC properties.
 */
export type IdentityTypeWithKYC = IdentityType & WithKYC;

/**
 * Encrypted identity, as stored on the ledger.
 */
type EncryptedIndentity = Encrypted;

/**
 * Data returned by the network when requesting an identity.
 */
export type IdentityResponseObject = WithKYC & { 
    encryptedIdentity: EncryptedIndentity;
    uniqueHash: string;
};

/**
 * Object returned by the network when requesting an identity.
 */
export type RequestIdentityResponseObject = RequestReponseObject & { 
    identity: IdentityResponseObject;
};

/**
 * Object returned by Axios when requesting an identity.
 */
export type RequestIdentityResponse = AxiosResponse<RequestIdentityResponseObject>;

const crypt = new Crypt();

/**
 * Check the validity of the documentation url, with regexp.
 */
export const validateDocumentationUrl = (url: string): boolean => {
    const regex = /^https?:\/\/imgur.com\/a\/([\w]{7})$/gm;
    return regex.test(url);
};

/**
 * Request an identity from the network.
 */
export const getIdentity = (
    {
        user,
        id,
    }: {
        user: User,
        id?: string,
    },
): Promise<RequestIdentityResponse> => 
    request({
        username: user.username,
        wallet: user.wallet,
        url: appConfig.nerves.identity.url,
        method: 'GET',
        params: {
            identityId: id,
        },
    });

/**
 * Submit a new identity to the network.
 */
export const postIdentity = (
    {
        user,
        encryptedIdentity,
        uniqueHash,
    }: {
        user: User,
        encryptedIdentity: Encrypted,
        uniqueHash: string,
    },
): Promise<RequestIdentityResponse> => 
    request({
        username: user.username,
        wallet: user.wallet,
        url: appConfig.nerves.identity.url,
        method: 'POST',
        data: {
            encryptedIdentity,
            uniqueHash,
        },
    });

/**
 * Request the identity of the logged in user from the network.
 */
export const getMyIdentity = async (
    {
        user,
        onInfo,
    }: {
        user: User,
        onInfo?: (info: InfoType) => void,
    },
): Promise<IdentityTypeWithKYC> => {
    const setInfo = onInfo ? onInfo : () => null;

    // get encrypted identity
    setInfo(makeInfoProps({ type: 'info', value: 'Pulling your encrypted identity ...', loading: true }));
    const resIdentity = await getIdentity({ user });
    if (!resIdentity || !resIdentity.data.success){
        setInfo(makeInfoProps({ type: 'error', value: resIdentity.data.message || 'error', loading: false }));
    }

    // get job list containing the jobId used for identity verification
    setInfo(makeInfoProps({ type: 'info', value: 'Pulling your verification job ...', loading: true }));
    const resJobList = await getJobList({ user, chaincode: 'identity', key: user.id });
    if (!resJobList || !resJobList.data.success){
        setInfo(makeInfoProps({ type: 'error', value: resJobList.data.message || 'error', loading: false }));
    }
    const jobId = resJobList.data.list[0].jobId;

    // get the keypair used for encrypting the identity
    setInfo(makeInfoProps({ type: 'info', value: 'Pulling your shared keypair used for the verification job ...', loading: true }));
    const keypairId = `job||${user.id}||${jobId}`;
    const resEncryptedKeypair = await getEncryptedKeypair({ keypairId, user });
    if (!resEncryptedKeypair || !resEncryptedKeypair.data.success){
        setInfo(makeInfoProps({ type: 'error', value: resEncryptedKeypair.data.message || 'error', loading: false }));
    }
    const sharedKeypair = decryptKeypair({ user, encryptedKeypair: resEncryptedKeypair.data.keypair });

    // decrypt and return the identity
    setInfo(makeInfoProps({ type: 'info', value: 'Decrypting ...', loading: true }));
    const decryptedIdentity = decryptIdentity({ keypair: sharedKeypair, identityResponseObject: resIdentity.data.identity });
    const identityWithKyc: IdentityTypeWithKYC = { 
        ...decryptedIdentity,
        kyc: resIdentity.data.identity.kyc,
        confirmations: resIdentity.data.identity.confirmations,
    };
    setInfo(makeInfoProps({ type: 'info', value: '', loading: false }));
    return identityWithKyc;
};

/**
 * Create an identity object and submit it to the network.
 */
export const createIdentity = async (
    {
        citizen,
        user,
        onInfo,
    }: {
        citizen: IdentityType, 
        user: User,
        onInfo?: (info: InfoType) => void,
    },
): Promise<InfoType> => {
    const setInfo = onInfo ? onInfo : () => null;

    let info = makeInfoProps({ type: 'info', value: 'Submitting...', loading: true });
    setInfo(info);

    // validate documentation url
    if (!validateDocumentationUrl(citizen.documentation)) {
        info = makeInfoProps({ type: 'error', value: 'Documentation URL is incorrect. Format: https://imgur.com/a/5a15vOr', loading: false });
        setInfo(info);
        return info;
    }

    // create keypair (to be shared later)
    const keypairToShare = await generateKeyPair();

    // encrypt the identity with the publicKey
    const encryptedIdentity = crypt.encrypt(keypairToShare.publicKey, JSON.stringify(citizen));
    
    // post the identity to the nerves
    const resIdentity = await postIdentity({ user, encryptedIdentity, uniqueHash: uniqueHashFromIdentity(citizen) });
    if (!resIdentity || !resIdentity.data.success){
        info = makeInfoProps({ type: 'error', value: resIdentity.data.message, loading: false });
        setInfo(info);
        return info;
    }
    info = makeInfoProps({ type: 'info', value: resIdentity.data.message, loading: true });
    setInfo(info);
    
    // create verification jobs
    const resJob = await postJob({ user, encryptedIdentity });
    if (!resJob || !resJob.data.success) {
        info = makeInfoProps({ type: 'error', value: resJob.data.message, loading: false });
        setInfo(info);
        return info;
    }
    info = makeInfoProps({ type: 'info', value: resJob.data.message, loading: true });
    setInfo(info);
    const { workersIds, jobId } = resJob.data;

    // share the keypair with the workers
    const myEncryptedKeyPair = JSON.stringify(crypt.encrypt(user.keypair.publicKey, JSON.stringify(keypairToShare)));
    const resKeypair = await postEncryptedKeypair({ workersIds, keypairToShare, jobId, myEncryptedKeyPair, user });
    if (!resKeypair || !resKeypair.data.success) {
        info = makeInfoProps({ type: 'error', value: resKeypair.data.message, loading: false });
        setInfo(info);
        return info;
    }
    info = makeInfoProps({ 
        type: 'info', 
        value: 'Your identity have been successfully created. Wait for confirmations. You will be redirected.', 
        loading: false,
    });
    setInfo(info);

    return info;
};

/**
 * Retreive the job details of a given jobId. In this context, the job is an identity verification task.
 */
export const getIdentityVerificationJob = async (
    {
        jobId,
        user,
        onInfo,
    }: {
        jobId: string,
        user: User,
        onInfo?: (info: InfoType) => void,
    },
): Promise<[IdentityTypeWithKYC, IdentityTypeWithKYC] | null> => {
    const setInfo = onInfo ? onInfo : () => null;

    // get job
    const resJob = await getJob({ user, jobId });
    if( !resJob || !resJob.data.success) {
      setInfo(makeInfoProps({ type: 'error', value: resJob.data.message || 'error', loading: false }));
      return null;
    }
    setInfo(makeInfoProps({ type: 'info', value: resJob.data.message, loading: true }));
    const job = resJob.data.job;

    // get shared keypair to decrypt the job
    const keypairId = `job||${job.creator}||${jobId}`;
    const resEncryptedKeypair = await getEncryptedKeypair({ keypairId, user });
    if( !resEncryptedKeypair || !resEncryptedKeypair.data.success) {
        setInfo(makeInfoProps({ type: 'error', value: resEncryptedKeypair.data.message || 'error', loading: false }));
        return null;
    }
    setInfo(makeInfoProps({ type: 'info', value: resEncryptedKeypair.data.message, loading: true }));
    const sharedKeypair = decryptKeypair({ user, encryptedKeypair: resEncryptedKeypair.data.keypair });
    const decryptedJob = decryptJob({ keypair: sharedKeypair, encryptedJob: job.data });

    // get job creator identity
    const resCreatorIdentity = await getIdentity({ user, id: job.creator });
    if( !resCreatorIdentity || !resCreatorIdentity.data.success) {
        setInfo(makeInfoProps({ type: 'error', value: resCreatorIdentity.data.message || 'error', loading: false }));
        return null;
    }
    setInfo(makeInfoProps({ type: 'info', value: '', loading: false}));
    const creatorIdentity = decryptIdentity({ keypair: sharedKeypair, identityResponseObject: resCreatorIdentity.data.identity });

    return [
        {
            ...decryptedJob,
            uniqueHash: uniqueHashFromIdentity(decryptedJob),
            confirmations: resCreatorIdentity.data.identity.confirmations,
            kyc: resCreatorIdentity.data.identity.kyc,
        },
        {
            ...creatorIdentity,
            confirmations: resCreatorIdentity.data.identity.confirmations,
            kyc: resCreatorIdentity.data.identity.kyc,
        },
    ];
};

/**
 * Decrypt an encrypted identity with a Keypair.
 */
export const decryptIdentity = (
    {
        keypair,
        identityResponseObject,
    }: {
        keypair: Keypair,
        identityResponseObject: IdentityResponseObject,
    },
): IdentityType => {
    const crypt = new Crypt();
    const rawIdentity = crypt.decrypt(keypair.privateKey, identityResponseObject.encryptedIdentity);
    return { ...JSON.parse(rawIdentity.message), uniqueHash: identityResponseObject.uniqueHash };
};

/**
 * Check if the identity object of the user willing to be verified exactly matches the details of the verification job.
 * It's a front end filter against malformated malicious jobs, trying to get verified an identity that should not be approved.
 */
export const canApproveIdentityVerificationJob = (
    verificationJob: [IdentityTypeWithKYC, IdentityTypeWithKYC] | null,
): boolean => 
    verificationJob
    && verificationJob[0].uniqueHash === verificationJob[1].uniqueHash
    && isEqual(verificationJob[0], verificationJob[1]);

/**
 * Used for the onClick event of the `submit` button for submitting a new identity.
 * It creates an identity, and store it in the `users` object/store.
 */
export const submitCreateIdentity = async (
    {
        e,
        user,
        users,
        citizen,
        onInfo,
        onComplete,
        setUsers,
    }: {
        e: Event,
        user: User,
        users: UsersType,
        citizen: IdentityType,
        onInfo?: (info: InfoType) => void,
        onComplete?: () => void,
        setUsers?: (u: UsersType) => void,
    },
): Promise<void> => {
    e.preventDefault();
    const info = await createIdentity({ citizen, user, onInfo });
    if (info.type === 'info') {
        let loggedInUser = users.users.filter(u => u.username === users.loggedInUser)[0];
        const loggedIndex = users.users.indexOf(loggedInUser);
        loggedInUser = { ...loggedInUser, identity: {...citizen} };
        users.users[loggedIndex] = loggedInUser;

        if (setUsers) setUsers(users);
        if (onComplete) onComplete();
    }
};

/**
 * Check if the `Submit` button for submitting a new identity should be disabled or not.
 */
export const submitCreateIdentityIsDisabled = (citizen: IdentityType): boolean =>
    citizen.firstname.length === 0
    || citizen.lastname.length === 0
    || citizen.nation.length === 0
    || citizen.nationalId.length === 0
    || citizen.birthdate.length !== 10
    || citizen.documentation.length === 0;
