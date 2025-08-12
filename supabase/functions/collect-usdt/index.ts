/**
 * 개인 지갑으로 입금된 USDT 수령
 *  - 입금된 USDT는 운영지갑으로 전송하고 Wallet 테이블의 usdt_balance 필드 업데이트
 */

// Deno.serve is now built-in, no import needed
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
import { verifyTurnstileToken } from "../utils/turnstileUtils.ts";

// Edge Function 시작
Deno.serve(async (req) => {
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
    const { address, amount, turnstileToken } = requestData;

    // 검증
    if (address !== wallet.address) {
      return new Response(
        JSON.stringify({ error: "Invalid address" }),
        { status: 400, headers },
      );
    }

    // collect-usdt 요청시 block 사용자는 체크하지 않는다.

    // turnstile 토큰 검증
    // turnstileToken:  0.lVHGmL27wx9kSzWNiELzKGVL0trRtbzm56GZKX3Gfk3VyhavPD7xwLVGIRN4BITABwKLZ8cTLPv_uxSRtUIg9QGnTGx3Z9EwPzb9cjqSycJDVlUK-JEtTngvHJ0EUa_tu77BHRADjnjxSba623cj0x7hjAy9PFD4lv97FoCA2WOPAh2VLriIWjsEs9GsqqTI3Crfi0qlyWJGgjDW4drf_0cJQ5Sa_DApAs-bBeQJY4PYkAhPfTphr3NNLXNtykO7C3vjQys514es4uWnRDw69ntABKn8hHv7Xjs3fyjg7PB5ZOMw83NJO5HzAEDRw9RJyKBm6STE3Qtxaq09__EavbMfmOauP4qEuQ1yRe5D6tP-QCVHJQERAPBjo9ZXDVK6rCjWNF-4Yh9hprZXNtt7h32icq7-SSmGFchZWwad6kdiuposT3NCFghPwibWAdISzBPEp77wfOjAp4R_YerOQgXrrKGMeYa1j9HTG9HnlIXQ9aG8ZroSqsNVTDZ4cfoVaXqr7ANQB13uAzQFR6jnteXLTgaKLFM1GVK8YSxQR5XhVbG0vu_mpG8pYNNmOvwT9uDYnaTO5Ila_mVfnE8hcyo5c0KxxtTKfpldSxVdwiVNLDf_A6wOQyHZ6TBL5dwJJc8tuBkFZKXJqkSSViJhDLCZ5AapcvamOg-QDj5w52LFi7fB0k2IyXmcW_kWa4OJwx-4pXMzZ7hHqMiHKqb2fnbwBRspdjDC1BjWTuTlUsIy73ExeyYV6dR9ezD21o9VTWOZr1YJ-4lUaTY8iq-hOsdYyT86dgDZgf5nu64M1-IpP6ETVUw0aGh-p7fcKq182lvPIJTqSqpAMXEuPTYLJgpM1p_UxlxGW81hTt9Px6DP7oJfK0h37rn70Y_XNb1bnyIDbPMo-ajeW-FDFseQBQ.heWyAY_AbsTWdgiePFqCMA.929d0e9efb10f2a4c57cc15a56a4601fc3db6e1363d8c6d983ee4ef58e026491

    console.log(`turnstileToken: ${turnstileToken.slice(0, 32)}...`);
    if (turnstileToken) {
      if (
        Deno.env.get("DEBUG_MODE") === "true" &&
        turnstileToken === "local-dev-token"
      ) {
        // 로컬 개발 환경에서만 local-dev-token 허용
        console.log("🔧 DEBUG_MODE is true");
      } else {
        // 토큰 검증
        const turnstileResult = await verifyTurnstileToken(turnstileToken);
        if (!turnstileResult.success) {
          console.error("🚫 Invalid turnstile token");
          // await blockUser(user.id, "Invalid turnstile token");
          return new Response(
            JSON.stringify({ error: "Invalid turnstile token" }),
            { status: 400, headers },
          );
        }
      }
    } else {
      // 토큰이 없으면 예전 버전이므로 페이지 리로드 필요
      console.log("🚫 No turnstile token: Need page reload");
      return new Response(
        JSON.stringify({ error: "Need page reload" }),
        { status: 400, headers },
      );
    }

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
              error: "Too Many Requests",
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
