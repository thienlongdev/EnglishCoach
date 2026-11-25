/**
 * WebAuthn in the browser: turns the server's JSON options into the binary form `navigator.credentials` wants and
 * the authenticator's answer back into JSON. Nothing here is a secret: the private key never leaves the
 * authenticator, and the browser binds every answer to this page's real origin (which is what makes the factor
 * resistant to phishing: a look-alike site gets an answer for ITS origin, which the server refuses).
 */
type Json = Record<string, unknown>;

function toBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer | null | undefined): string | undefined {
  if (!buffer) return undefined;
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const descriptors = (list: unknown) =>
  (Array.isArray(list) ? list : []).map((d: Json) => ({ ...d, id: toBuffer(String(d.id)) })) as PublicKeyCredentialDescriptor[];

export function webAuthnSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
    && !!navigator.credentials && window.isSecureContext;
}

/** Creates a passkey for the server's registration options; resolves to the JSON the server verifies. */
export async function createPasskey(publicKey: Json): Promise<Json> {
  const user = publicKey.user as Json;
  const options: PublicKeyCredentialCreationOptions = {
    ...(publicKey as unknown as PublicKeyCredentialCreationOptions),
    challenge: toBuffer(String(publicKey.challenge)),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: toBuffer(String(user.id)) },
    excludeCredentials: descriptors(publicKey.excludeCredentials),
  };
  const credential = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
  if (!credential) throw new Error('cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
    clientExtensionResults: {},
  };
}

/** Proves possession of an enrolled passkey for the server's assertion options. */
export async function getPasskeyAssertion(publicKey: Json): Promise<Json> {
  const options: PublicKeyCredentialRequestOptions = {
    ...(publicKey as unknown as PublicKeyCredentialRequestOptions),
    challenge: toBuffer(String(publicKey.challenge)),
    allowCredentials: descriptors(publicKey.allowCredentials),
  };
  const credential = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential | null;
  if (!credential) throw new Error('cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      ...(response.userHandle && response.userHandle.byteLength > 0 ? { userHandle: toBase64Url(response.userHandle) } : {}),
    },
    clientExtensionResults: {},
  };
}
