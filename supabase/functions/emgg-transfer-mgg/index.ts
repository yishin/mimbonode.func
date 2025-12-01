/**
 * 플랫폼에서 MGG 토큰을 전송하는 Edge Function
 * 인증된 요청에 대해서만 처리
 */

import { sendMgg, setOperationWallet } from "../utils/tokenUtils.ts";
// import { setCorsHeaders } from "../utils/corsUtils.ts";
import { getSettings } from "../utils/authUtils.ts";
import {
  completeFunctionCall,
  failFunctionCall,
  trackFunctionCall,
} from "../utils/trackUtils.ts";

// Edge Function 시작
Deno.serve(async (req) => {
  // API 전용 CORS 설정 (모든 오리진 허용)
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-platform-token, content-type",
    "Access-Control-Max-Age": "86400",
  });

  // OPTIONS 요청 처리 (CORS preflight)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 함수 호출 추적 시작
  const callId = await trackFunctionCall(
    "emgg-transfer-mgg",
    { description: "eMGG MGG token transfer" },
  );

  // 메타데이터 초기화
  const metadata: any = {
    start_time: new Date().toISOString(),
    description: "eMGG MGG token transfer",
  };

  console.log("Starting eMGG MGG transfer...");
  console.log(`Function call tracked with ID: ${callId}`);

  try {
    // 환경 변수에서 플랫폼 액세스 토큰 가져오기
    const EMGG_ACCESS_TOKEN = Deno.env.get("EMGG_ACCESS_TOKEN");
    if (!EMGG_ACCESS_TOKEN) {
      throw new Error("eMGG access token not configured");
    }

    // X-Platform-Token 헤더에서 플랫폼 토큰 확인
    const platformToken = req.headers.get("x-platform-token");
    
    // 디버깅을 위한 로그 (프로덕션에서는 제거)
    console.log("Platform token received:", platformToken ? "Present" : "Missing");
    console.log("Token length:", platformToken?.length);
    console.log("Expected token starts with:", EMGG_ACCESS_TOKEN.substring(0, 10) + "...");
    
    if (!platformToken) {
      throw new Error("Platform token missing");
    }

    // 액세스 토큰 검증
    if (platformToken !== EMGG_ACCESS_TOKEN) {
      throw new Error("Unauthorized: Invalid platform token");
    }

    // 요청 본문 파싱
    const body = await req.json();
    const { from, to, amount } = body;

    // 필수 파라미터 검증
    if (!from || !to || !amount) {
      throw new Error(
        "Missing required parameters: from, to, amount",
      );
    }

    // amount 검증 (양수인지 확인)
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error("Invalid amount: must be a positive number");
    }

    // 설정 로드 및 운영 지갑 설정
    const settings = await getSettings();
    setOperationWallet(settings.wallet_operation);

    const normalizeAddresses = (raw: unknown): string[] => {
      if (!raw) {
        return [];
      }

      if (Array.isArray(raw)) {
        return raw
          .filter((addr): addr is string => typeof addr === "string")
          .map((addr) => addr.trim().toLowerCase())
          .filter((addr) => addr.length > 0);
      }

      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) {
          return [];
        }

        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed
              .filter((addr): addr is string => typeof addr === "string")
              .map((addr) => addr.trim().toLowerCase())
              .filter((addr) => addr.length > 0);
          }
        } catch (_err) {
          // 문자열이 JSON이 아니면 계속 진행
        }

        return trimmed
          .split(",")
          .map((addr) => addr.trim().toLowerCase())
          .filter((addr) => addr.length > 0);
      }

      return [];
    };

    const allowedAddresses = [
      ...normalizeAddresses(settings.emgg_wallet_address),
      ...normalizeAddresses(settings.staking_fund_address),
      ...normalizeAddresses(settings.staking_flex_address),
      ...normalizeAddresses(settings.staking_fixed_3_address),
      ...normalizeAddresses(settings.staking_fixed_6_address),
      ...normalizeAddresses(settings.staking_fixed_9_address),
      ...normalizeAddresses(settings.staking_fixed_12_address)
    ];

    if (allowedAddresses.length === 0) {
      throw new Error(
        "No authorized eMGG/staking wallet addresses configured in settings",
      );
    }

    if (!allowedAddresses.includes(from.toLowerCase())) {
      throw new Error(
        "Unauthorized: from address does not match configured eMGG/staking wallet addresses",
      );
    }

    // 전송 금액이 최대 허용 금액을 초과하는지 검증
    if (settings.emgg_transfer_max_amount) {
      const maxAmount = parseFloat(settings.emgg_transfer_max_amount);
      if (!isNaN(maxAmount) && amountNum > maxAmount) {
        throw new Error("Transfer amount exceeds maximum allowed");
      }
    }

    console.log(
      `Transferring ${amount} MGG from ${from} to ${to}`,
    );

    // MGG 토큰 전송
    const result = await sendMgg(from, to, amount.toString());

    if (!result.success) {
      throw new Error("MGG transfer failed");
    }

    console.log(`MGG transfer successful. Transaction hash: ${result.txHash}`);

    // 메타데이터 업데이트
    metadata.from = from;
    metadata.to = to;
    metadata.amount = amount;
    metadata.transaction_hash = result.txHash;
    metadata.gas_used = result.gasUsed;
    metadata.block_number = result.blockNumber;
    metadata.end_time = new Date().toISOString();

    // 함수 호출 완료 기록
    await completeFunctionCall(callId, {
      result: "success",
      metadata,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "MGG transfer completed successfully",
        transaction_hash: result.txHash,
        gas_used: result.gasUsed,
        block_number: result.blockNumber,
        from: from,
        to: to,
        amount: amount,
      }),
      {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("eMGG MGG transfer error:", error);

    // 에러 메타데이터 업데이트
    metadata.error = error.message;
    metadata.end_time = new Date().toISOString();

    // 함수 호출 실패 기록
    await failFunctionCall(callId, {
      error: error.message,
      metadata,
    });

    return new Response(
      JSON.stringify({
        success: false,
        message: error.message || "Failed to transfer MGG",
      }),
      {
        status: error.message?.includes("Unauthorized") ? 401 : 400,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
