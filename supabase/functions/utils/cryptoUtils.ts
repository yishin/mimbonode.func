// cryptoUtils.ts

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * scrypt 키 생성 함수
 */
async function generateScryptKey(
  password: string,
  salt: string,
  keyLength: number,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  // PBKDF2를 사용하여 scrypt와 유사한 키 유도
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000, // scrypt의 대체값으로 높은 반복 횟수 사용
      hash: "SHA-256",
    },
    passwordKey,
    keyLength * 8,
  );

  return new Uint8Array(derivedBits);
}

/**
 * 16진수 문자열을 Uint8Array로 변환
 */
function hexToUint8Array(hexString: string): Uint8Array {
  const matches = hexString.match(/.{1,2}/g) || [];
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/**
 * Uint8Array를 16진수 문자열로 변환
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 개인키 암호화 함수
 */
async function encryptPrivateKey(
  privateKey: string,
  key: string,
): Promise<string> {
  // scrypt 키 생성
  const ek = await generateScryptKey(key, "specialSalt", 32);

  // IV 생성
  const iv = crypto.getRandomValues(new Uint8Array(16));

  // 암호화 키 생성
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ek,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );

  // 암호화
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-CBC",
      iv,
    },
    cryptoKey,
    encoder.encode(privateKey),
  );

  // IV와 암호화된 데이터를 16진수로 변환하고 결합
  return uint8ArrayToHex(iv) + ":" + uint8ArrayToHex(new Uint8Array(encrypted));
}

/**
 * 개인키 복호화 함수
 */
async function decryptPrivateKey(
  encryptedPrivateKey: string,
  key: string,
): Promise<string> {
  // scrypt 키 생성
  const ek = await generateScryptKey(key, "specialSalt", 32);

  // IV와 암호화된 데이터 분리
  const [ivHex, encryptedHex] = encryptedPrivateKey.split(":");

  // 16진수 문자열을 Uint8Array로 변환
  const iv = hexToUint8Array(ivHex);
  const encryptedData = hexToUint8Array(encryptedHex);

  // 복호화 키 생성
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ek,
    { name: "AES-CBC", length: 256 },
    false,
    ["decrypt"],
  );

  // 복호화
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-CBC",
      iv,
    },
    cryptoKey,
    encryptedData,
  );

  return decoder.decode(decrypted);
}

// 사용 예시
async function example() {
  try {
    const privateKey = "my-super-secret-private-key";
    const password = "user-provided-password";

    console.log("원본 개인키:", privateKey);

    const encrypted = await encryptPrivateKey(privateKey, password);
    console.log("암호화된 개인키:", encrypted);

    const decrypted = await decryptPrivateKey(encrypted, password);
    console.log("복호화된 개인키:", decrypted);
  } catch (error) {
    console.error("에러 발생:", error);
  }
}

export { decryptPrivateKey, encryptPrivateKey };
