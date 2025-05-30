/**
 * 개인 지갑으로 입금된 USDT 수령
 *  - 입금된 USDT는 운영지갑으로 전송하고 Wallet 테이블의 usdt_balance 필드 업데이트
 */

import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import {
  getAddressBySid,
  getAddressByUsername,
  supabase,
} from "../utils/supabaseClient.ts";
import {
  getBnbBalance,
  getMggBalance,
  getUsdtBalance,
  getUsdtLastTx,
  sendBnb,
  sendMgg,
  sendUsdt,
  setOperationWallet,
} from "../utils/tokenUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";
import { sendTelegramMessage } from "../utils/telegramUtils.ts";

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

    // 사용자 정보 조회
    const { user, profile, wallet, settings } = authResult;
    console.log(`🚀 user_id: ${profile.username} (${user.id})`);

    // 요청 데이터 파싱 : 없음
    const requestData = await req.json();
    const { address, amount } = requestData;

    // 검증
    if (address !== wallet.address) {
      return new Response(
        JSON.stringify({ error: "Invalid address" }),
        { status: 400, headers },
      );
    }

    // collect-usdt 요청시 block 사용자는 체크하지 않는다.

    ////////////////////////////////
    // 중복 실행 방지
    try {
      // 30s 이내 이전 요청이 없으면 새로운 요청 생성
      const { data: trxRequest, error: trxError } = await supabase
        .from("trx_requests")
        .insert({
          user_id: user.id,
          username: profile.username,
          type: "DEPOSIT",
          data: {
            device_info: req.headers.get("user-agent"),
            client_time: new Date().toISOString(),
            ...requestData,
          },
        })
        .select()
        .single();

      if (trxError) {
        // 유니크 제약 위반 (23505)인 경우 = 30s 이내 중복 요청
        if (trxError.code === "23505") {
          console.log("Duplicate trx request detected");

          // collect-usdt에서는 중복 요청 로그 기록 하지 않음
          // try {
          //   await supabase.from("debug_logs").insert({
          //     function_name: "collect-usdt",
          //     message: "Duplicate request",
          //     data: { user_id: user.id, username: profile.username },
          //   });
          // } catch (logError) {
          //   console.error("Error logging:", logError);
          // }

          return new Response(
            JSON.stringify({
              error: "Rate limit exceeded.",
            }),
            { status: 429, headers },
          );
        }

        // 다른 에러인 경우
        console.error("Error creating trx record:", trxError);
        return new Response(
          JSON.stringify({ error: "Failed to process trx request" }),
          { status: 500, headers },
        );
      }
      console.log("trx request created:", trxRequest.id);
    } catch (dbError) {
      console.error("Database error:", dbError);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    ///////////////////////////////
    // 입금된 USDT 수령
    ///////////////////////////////

    let type = "DEPOSIT";
    let from = "EXTERNAL"; //profile.username; // USDT가 입금된 tx를 찾아서 기록해야 함
    let fromToken = "USDT";
    let fromAmount = amount;
    let to = profile.username; // 트랜젝션에 사용자가 받는것으로 기록
    let toToken = "";
    let toAmount = 0;
    let txHash = "";
    let txAddress = "";

    try {
      // 0. 블럭체인에서 마지막 tx 기록 조회
      // const lastTx = await getUsdtLastTx(address);
      // if (!lastTx?.txHash) {
      //   throw new Error("Failed to get last USDT transaction");
      // }

      // txHash = lastTx.txHash;
      // txAddress = lastTx.txAddress;

      // 1. 개인 지갑에서 입금된 USDT 조회
      const balance = await getUsdtBalance(address);
      if (Number(balance) < 1) {
        console.warn("Not enough USDT to collect");
        return new Response(
          JSON.stringify({ error: "Not enough USDT to collect" }),
          { status: 200, headers },
        );
      }

      //
      fromAmount = balance;
      toToken = "USDT";
      toAmount = balance;

      // 2. 입금용 운영 지갑으로 전송
      setOperationWallet(settings.wallet_operation); // 수수료는 운영지갑에서 처리
      const result = await sendUsdt(address, settings.wallet_deposit, toAmount);

      if (!result.txHash) {
        throw new Error("Failed to DEPOSIT USDT process");
      }
      txHash = result.txHash;

      // 4. Wallet 테이블의 usdt_balance 필드 업데이트
      const { data: walletData, error: walletError } = await supabase.rpc(
        "collect_usdt",
        {
          userid: user.id,
          amount: balance,
        },
      );

      if (walletError) {
        throw new Error("Failed to update usdt_balance");
      }

      console.log("Success collect_usdt:" + balance);

      // 텔레그램 메시지 전송
      const message =
        `━━━━━━━━━━━━━━━\n💰 외부 입금 ${profile.username}\nUSDT ${balance}`;
      await sendTelegramMessage(message);

      // 성공 응답
      return new Response(
        JSON.stringify({
          success: true,
          amount: balance,
          message: "Collect successful",
        }),
        { status: 200, headers },
      );
    } catch (error) {
      console.error("Unexpected error:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    } finally {
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
            exchange_rate: 0,
            status: txHash ? "COMPLETED" : "FAILED",
            fee_rate: 0,
            fee_amount: 0,
            fee_tx_hash: "",
          },
        ])
        .select()
        .single();

      if (insertError) {
        console.error("Error creating transaction record:", insertError);
        return new Response(
          JSON.stringify({ error: "Error creating transaction record" }),
          { status: 500, headers },
        );
      }
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers },
    );
  }
});
