import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import {
  getAddressBySid,
  getAddressByUsername,
  supabase,
} from "../utils/supabaseClient.ts";
import {
  sendBnb,
  sendMgg,
  sendUsdt,
  setFeeWallet,
} from "../utils/tokenUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";

// Edge Function 시작
serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  try {
    // 사용자 인증
    const authResult = await authenticateRequest(req);
    if (authResult.error) {
      return new Response(
        JSON.stringify({ error: authResult.error }),
        {
          status: authResult.status,
          headers,
        },
      );
    }

    const { user, profile, settings } = authResult;
    console.log("user_id:" + JSON.stringify(user.id));

    // 요청 데이터 파싱
    const { type, from, fromToken, fromAmount, to, toToken, toAmount } =
      await req.json();

    ////////////////////////////////
    // 정책 확인
    const isAdmin = profile.user_role === "admin";

    // 관리자는 제한없음
    if (!isAdmin) {
      // 기본 사항 체크
      if (!settings.wallet_free || settings.wallet_free.length !== 42) {
        return new Response(
          JSON.stringify({
            error: "Not specified wallet address for free gas fee.",
          }),
          { status: 400, headers },
        );
      }

      // 출금 정책 확인
      if (type === "WITHDRAW") {
        if (
          (fromToken === "USDT" && settings.enable_withdraw_usdt !== "true") ||
          (fromToken === "MGG" && settings.enable_withdraw_mgg !== "true") ||
          (fromToken === "BNB" && settings.enable_withdraw_bnb !== "true")
        ) {
          return new Response(
            JSON.stringify({
              error: "Withdrawals are temporarily suspended.",
            }),
            { status: 200, headers },
          );
        }
      }

      // 최소 출금/스왑/전송 금액 확인
      if (
        (type === "WITHDRAW" && fromToken === "USDT" &&
          fromAmount < settings.minimum_withdraw_usdt) ||
        (type === "WITHDRAW" && fromToken === "MGG" &&
          fromAmount < settings.minimum_withdraw_mgg) ||
        (type === "SWAP" && fromToken === "USDT" &&
          fromAmount < settings.minimum_swap_usdt) ||
        (type === "SWAP" && fromToken === "MGG" &&
          fromAmount < settings.minimum_swap_mgg) ||
        (type === "TRANSFER" && fromToken === "USDT" &&
          fromAmount < settings.minimum_transfer_usdt) ||
        (type === "TRANSFER" && fromToken === "MGG" &&
          fromAmount < settings.minimum_transfer_mgg)
      ) {
        return new Response(
          JSON.stringify({
            error: "Amount is less than the minimum required.",
          }),
          { status: 400, headers },
        );
      }

      // 출금시 관리자 승인 체크/출금 요청
      if (type === "WITHDRAW") {
        if (fromToken === "USDT" && settings.minimum_withdraw_usdt > 0) {
          // 1일이내 출금 금액 확인
          const prevWithdrawals = await supabase
            .from("transactions")
            .select("sum(to_amount) as total_amount")
            .eq("user_id", user.id)
            .eq("type", "WITHDRAW")
            .eq("token", "USDT")
            .lte(
              "created_at",
              new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            )
            .single();

          if (
            prevWithdrawals.data.total_amount > settings.minimum_withdraw_usdt
          ) {
            // 허용금액 초과
            return new Response(
              JSON.stringify({ error: "Withdrawal amount exceeds the limit." }),
              { status: 200, headers },
            );
          }

          if (
            prevWithdrawals.data.total_amount + fromAmount >
              settings.minimum_withdraw_usdt
          ) {
            // 관리자 승인 요청
            const { data: transactionData, error: insertError } = await supabase
              .from("transactions")
              .insert([
                {
                  user_id: user.id,
                  from,
                  from_token: "USDT",
                  from_amount: fromAmount,
                  to: to,
                  status: "CONFIRM",
                },
              ]);

            if (insertError) {
              console.error("Error creating transaction record:", insertError);
              return new Response(
                JSON.stringify({ error: "Request failed." }),
                { status: 200, headers },
              );
            }

            return new Response(
              JSON.stringify({ success: true }),
              { status: 200, headers },
            );
          }
        }
      }
    } // 관리자외 정책 체크 끝

    ////////////////////////////////
    // 요청별 처리
    setFeeWallet(settings.wallet_free);

    const fromAddress = from.startsWith("sid:")
      ? await getAddressBySid(from.split(":")[1])
      : from.startsWith("0x")
      ? from
      : await getAddressByUsername(from);
    const toAddress = to.startsWith("0x") ? to : await getAddressByUsername(to);

    let txHash = "";
    let feeTxHash = "";

    if (type === "TRANSFER") { // 내부 사용자에게 전송
      // 토큰 전송
      if (fromToken === "USDT") {
        // usdt 전송
        const result = await sendUsdt(fromAddress, toAddress, fromAmount);
        txHash = result.txHash;
        feeTxHash = result.feeTxHash;
      } else if (fromToken === "MGG") {
        // mgg 전송
        const result = await sendMgg(fromAddress, toAddress, fromAmount);
        txHash = result.txHash;
        feeTxHash = result.feeTxHash;
      } else if (fromToken === "BNB") {
        // bnb 전송
        const result = await sendBnb(fromAddress, toAddress, fromAmount);
        txHash = result.txHash;
        feeTxHash = result.feeTxHash;
      }
    } else if (type === "SWAP") {
    } else if (type === "DEPOSIT") {
      // 없음
    } else if (type === "WITHDRAW") {
      // 출금 정책 확인
    } else {
      // 에러
      return new Response(
        JSON.stringify({ error: "Invalid request" }),
        { status: 400, headers },
      );
    }

    ////////////////////////////////
    // fee 처리
    let feeAmount = 0; // 수수료 금액(mgg)
    let feeRate = 0; // 수수료 비율
    let feeHash = ""; // 수수료 트랜잭션 해시
    let fee = 0; // 수수료 전송 fee(bnb)

    if (!isAdmin) {
      // 관리자는 수수료 제외
      if (type === "WITHDRAW") {
        // 출금시 관리자 승인 체크/출금 요청
      }
    }

    ////////////////////////////////
    // 트랜잭션 기록 생성
    const { data: transactionData, error: insertError } = await supabase
      .from("transactions")
      .insert([
        {
          user_id: user.id,
          transaction_type: type,
          from: from,
          from_token: fromToken,
          from_amount: fromAmount,
          to: to,
          to_token: toToken,
          to_amount: toAmount,
          tx_hash: txHash,
          status: txHash ? "COMPLETED" : "FAILED",
          fee_rate: 0,
          fee_amount: 0,
          fee_tx_hash: null,
        },
      ])
      .select()
      .single();

    // 전송 성공 회신
    if (txHash && feeTxHash) {
      return new Response(
        JSON.stringify({
          success: true,
          data: transactionData,
          txHash: txHash,
          feeTxHash: feeTxHash,
        }),
        { status: 200, headers },
      );
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Transaction failed",
        }),
        { status: 200, headers },
      );
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers },
    );
  }
});
