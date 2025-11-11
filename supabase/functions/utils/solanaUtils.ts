// Edge Functions에서 솔라나 라이브러리
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = args.join(" ");
  // 불필요한 경고 메시지 숨기기
  if (message.includes("deprecated") || message.includes("experimental")) {
    return;
  }
  originalWarn.apply(console, args);
};

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "npm:@solana/web3.js";
import bs58 from "npm:bs58";

/**
 * Solana 관련 변수
 */

// mainnet endpoint
const SOLANA_ENDPOINT = Deno.env.get("SOLANA_ENDPOINT");
// 지갑 개인키만 있으면 주소는 자동으로 계산됨
const SOLANA_OPERATION_WALLET_PRIVATE_KEY = Deno.env.get(
  "SOLANA_OPERATION_WALLET_PRIVATE_KEY",
);

/**
 * SOL 금액을 lamports로 변환 (정수 단위로 정확한 계산)
 * 소수점 연산의 부정확성을 피하기 위해 정수로 처리
 */
function solToLamports(amount: any): number {
  const numAmount = parseFloat(amount.toString());
  // SOL을 lamports로 변환 후 버림 처리 (반올림 금지)
  return Math.floor(numAmount * LAMPORTS_PER_SOL);
}

/**
 * lamports를 SOL로 변환 (표시용)
 */
function lamportsToSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toString();
}

/**
 * SOL 잔액 확인
 *
 * @param address - 주소 (선택사항, 없으면 운영 지갑 조회)
 * @returns {String} SOL 잔액
 */
export async function getSolBalance(address?: string) {
  try {
    const connection = new Connection(SOLANA_ENDPOINT, "confirmed");

    let publicKey;
    if (!address || address === "") {
      if (!SOLANA_OPERATION_WALLET_PRIVATE_KEY) {
        throw new Error("SOLANA_OPERATION_WALLET_PRIVATE_KEY is not set");
      }

      let secretKey;
      try {
        // Base58 문자열 형식 (가장 일반적)
        try {
          secretKey = bs58.decode(SOLANA_OPERATION_WALLET_PRIVATE_KEY);
          if (secretKey.length !== 64) {
            throw new Error(
              "Invalid Base58 private key length - should be 64 bytes",
            );
          }
        } catch (base58Error: any) {
          throw new Error(
            "Invalid Base58 private key: " +
              (base58Error?.message || "Unknown error"),
          );
        }
      } catch (err: any) {
        throw new Error(
          "Failed to parse private key: " + (err?.message || "Unknown error"),
        );
      }

      const keypair = Keypair.fromSecretKey(secretKey);
      publicKey = keypair.publicKey;
    } else {
      publicKey = new PublicKey(address);
    }

    const balance = await connection.getBalance(publicKey);
    const balanceInSol = (balance / LAMPORTS_PER_SOL).toString();

    return balanceInSol;
  } catch (error: any) {
    console.error("SOL balance check failed:", {
      error: error?.message || "Unknown error",
      address,
      timestamp: new Date().toISOString(),
    });

    // 에러 발생 시 null 반환하여 에러와 실제 잔액 부족을 구분
    return null;
  }
}

/**
 * SOL 전송 (운영 지갑에서만 전송)
 *
 * @param toAddress - 수신자 주소
 * @param amount - 전송할 SOL 수량
 * @returns {Object} 전송 결과 객체
 */
export async function sendSol(toAddress: string, amount: any) {
  try {
    if (!SOLANA_ENDPOINT) {
      throw new Error("SOLANA_ENDPOINT is not set in environment variables");
    }

    if (!SOLANA_OPERATION_WALLET_PRIVATE_KEY) {
      throw new Error(
        "SOLANA_OPERATION_WALLET_PRIVATE_KEY is not set in environment variables",
      );
    }

    // 입력값 검증
    if (!toAddress || toAddress.trim() === "") {
      throw new Error("Destination address is required");
    }

    if (!amount || parseFloat(amount) <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    // SOL을 lamports로 변환 (정수 단위로 정확한 계산)
    const lamports = solToLamports(amount);
    const normalizedAmount = lamportsToSol(lamports);

    console.log(
      `Amount conversion: ${amount} SOL -> ${lamports} lamports -> ${normalizedAmount} SOL`,
    );

    const connection = new Connection(SOLANA_ENDPOINT, "confirmed");

    // 운영 지갑 키페어 생성 (private key로부터 주소도 자동 계산)
    let secretKey;
    try {
      // Base58 문자열 형식 (가장 일반적)
      try {
        secretKey = bs58.decode(SOLANA_OPERATION_WALLET_PRIVATE_KEY);
        if (secretKey.length !== 64) {
          throw new Error(
            "Invalid Base58 private key length - should be 64 bytes",
          );
        }
      } catch (base58Error: any) {
        throw new Error(
          "Invalid Base58 private key: " +
            (base58Error?.message || "Unknown error"),
        );
      }
    } catch (err: any) {
      throw new Error(
        "Failed to parse private key: " + (err?.message || "Unknown error"),
      );
    }

    const fromKeypair = Keypair.fromSecretKey(secretKey);

    const toPublicKey = new PublicKey(toAddress);

    // 트랜잭션 생성
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: toPublicKey,
        lamports: lamports,
      }),
    );

    // 트랜잭션 서명 및 전송
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [fromKeypair],
      { commitment: "confirmed" },
    );

    console.log(
      `💧 SOL transfer complete: ${normalizedAmount} SOL (${fromKeypair.publicKey.toString()} → ${toAddress})`,
    );

    return {
      success: true,
      txHash: signature,
    };
  } catch (error: any) {
    console.error("SOL transfer failed:", {
      error: error?.message || "Unknown error",
      toAddress,
      amount,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error: error?.message || "Unknown error",
      details: { toAddress, amount },
    };
  }
}
