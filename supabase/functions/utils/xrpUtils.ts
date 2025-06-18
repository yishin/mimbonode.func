// Edge Functions에서 XRPL 라이브러리 경고 억제
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = args.join(" ");
  // ClientRequest.options.createConnection 경고만 숨기기
  if (message.includes("ClientRequest.options.createConnection")) {
    return;
  }
  originalWarn.apply(console, args);
};

import { Client, Wallet, xrpToDrops } from "npm:xrpl";

/**
 * XRP 관련 변수
 */

// mainnet endpoint
const XRP_ENDPOINT = Deno.env.get("XRP_ENDPOINT");
// 지갑주소
const XRP_OPERATION_WALLET = Deno.env.get("XRP_OPERATION_WALLET");
// 지갑 SEED
const XRP_OPERATION_WALLET_SEED = Deno.env.get("XRP_OPERATION_WALLET_SEED");

/**
 * XRP 금액을 정규화 (소수점 6자리에서 버림)
 */
function normalizeXrpAmount(amount: any): string {
  const numAmount = parseFloat(amount.toString());
  // XRP는 최대 6자리 소수점까지 지원 - 버림 처리
  const multiplier = Math.pow(10, 6);
  const truncated = Math.floor(numAmount * multiplier) / multiplier;
  return truncated.toFixed(6);
}

/**
 * XRP 잔액 확인
 *
 * @param address - 주소
 * @returns {String} XRP 잔액
 */
export async function getXrpBalance(address: any) {
  if (!address || address === "") {
    address = XRP_OPERATION_WALLET;
  }

  try {
    const endpoint = XRP_ENDPOINT;

    const client = new Client(endpoint);
    await client.connect();

    const accountData = await client.request({
      command: "account_info",
      account: address,
      strict: true,
      ledger_index: "validated",
    });

    await client.disconnect();

    // Balance는 drops 단위이므로 XRP로 변환
    const balanceInDrops = accountData.result.account_data.Balance;
    const balanceInXrp = (parseInt(balanceInDrops) / 1000000).toString();

    return balanceInXrp;
  } catch (error: any) {
    console.error("XRP balance check failed:", {
      error: error?.message || "Unknown error",
      address,
      timestamp: new Date().toISOString(),
    });

    return "0";
  }
}

/**
 * XRP 전송
 *
 * @param fromAddress - 송신자 주소
 * @param toAddress - 수신자 주소
 * @param amount - 전송할 XRP 수량
 * @param destinationTag - 수신자 태그 (선택사항)
 * @returns {Object} 전송 결과 객체
 */
export async function sendXrp(
  fromAddress: any,
  toAddress: any,
  amount: any,
  destinationTag?: any,
) {
  if (!fromAddress || fromAddress === "") {
    fromAddress = XRP_OPERATION_WALLET;
  }

  try {
    if (!XRP_ENDPOINT) {
      throw new Error("XRP_ENDPOINT is not set in environment variables");
    }

    if (!XRP_OPERATION_WALLET_SEED) {
      throw new Error(
        "XRP_OPERATION_WALLET_SEED is not set in environment variables",
      );
    }

    // 입력값 검증
    if (!toAddress || toAddress.trim() === "") {
      throw new Error("Destination address is required");
    }

    if (!amount || parseFloat(amount) <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    // XRP 금액 정규화 (소수점 자리 제한)
    const normalizedAmount = normalizeXrpAmount(amount);

    // Destination Tag 검증
    if (destinationTag !== undefined && destinationTag !== null) {
      const tagNumber = parseInt(destinationTag);
      if (isNaN(tagNumber) || tagNumber < 0 || tagNumber > 4294967295) {
        throw new Error(
          "Destination tag must be a number between 0 and 4294967295",
        );
      }
    }

    console.log(`Normalized amount: ${amount} -> ${normalizedAmount}`);

    const client = new Client(XRP_ENDPOINT);
    await client.connect();

    try {
      // 운영 지갑에서 트랜잭션 서명
      const wallet = Wallet.fromSeed(XRP_OPERATION_WALLET_SEED);

      // 트랜잭션 준비
      const transactionData: any = {
        TransactionType: "Payment",
        Account: wallet.classicAddress, // 항상 운영 지갑에서 전송
        Destination: toAddress,
        Amount: xrpToDrops(normalizedAmount),
      };

      // Destination Tag가 있으면 추가
      if (destinationTag !== undefined && destinationTag !== null) {
        transactionData.DestinationTag = parseInt(destinationTag);
      }

      const prepared = await client.autofill(transactionData);

      // 트랜잭션 서명
      const signed = wallet.sign(prepared);

      // 트랜잭션 제출
      const result = await client.submitAndWait(signed.tx_blob);

      if (result.result.meta.TransactionResult === "tesSUCCESS") {
        const logMessage = destinationTag
          ? `💧 XRP transfer complete: ${normalizedAmount} XRP (${wallet.classicAddress} → ${toAddress}, Tag: ${destinationTag})`
          : `💧 XRP transfer complete: ${normalizedAmount} XRP (${wallet.classicAddress} → ${toAddress})`;

        console.log(logMessage);

        return {
          success: true,
          txHash: signed.hash,
          txResult: result.result.meta.TransactionResult,
          ledgerIndex: result.result.ledger_index,
          originalAmount: amount,
          normalizedAmount: normalizedAmount,
          destinationTag: destinationTag,
        };
      } else {
        throw new Error(
          `Transaction failed: ${result.result.meta.TransactionResult}`,
        );
      }
    } finally {
      await client.disconnect();
    }
  } catch (error: any) {
    console.error("XRP transfer failed:", {
      error: error?.message || "Unknown error",
      fromAddress,
      toAddress,
      amount,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error: error?.message || "Unknown error",
      details: { fromAddress, toAddress, amount, destinationTag },
    };
  }
}
