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
  sendBnb,
  sendMgg,
  sendUsdt,
  setOperationWallet,
} from "../utils/tokenUtils.ts";
import { getXrpBalance, sendXrp } from "../utils/xrpUtils.ts";
import { getSolBalance, sendSol } from "../utils/solanaUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";
import {
  getBnbPriceFromBinance,
  getSolPriceFromBinance,
  getXrpPriceFromBinance,
} from "../utils/exchangeUtils.ts";
import {
  sendBlockMessage,
  sendTelegramMessage,
} from "../utils/telegramUtils.ts";
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

    // 사용자 ip 조회
    const ip = req.headers.get("cf-connecting-ip");

    //
    const { user, profile, wallet, settings } = authResult;
    console.log(
      `🚀 user_id: ${profile.username} (${user.id}) ${profile.email} ${ip}`,
    );

    // 송금 막기 (임시 처리)
    // return new Response(
    //   JSON.stringify({ error: "Server maintenance" }),
    //   { status: 400, headers },
    // );

    // 요청 데이터 파싱
    const requestData = await req.json();
    const {
      type,
      from,
      fromToken,
      fromAmount,
      to,
      toToken,
      toAmount: toAmountOrg,
      destinationTag,
      turnstileToken,
      adminPage, // 관리자 페이지 여부
    } = requestData;
    // 요청데이터 log 출력
    console.log(
      `type: ${type || ""} from: ${from || ""} fromToken: ${
        fromToken || ""
      } fromAmount: ${fromAmount || 0} to: ${to || ""} toToken: ${
        toToken || ""
      } toAmount: ${toAmountOrg || 0}`,
    );

    // tx / fee 변수 초기화
    let toAmount = toAmountOrg;
    let txHash = "";
    let feeTxHash = "";
    let feeAmount = 0; // 수수료 금액(mgg)
    let exchangeRate = 0; // 환율
    let feeRate = 0; // 수수료 비율
    let feeHash = ""; // 수수료 트랜잭션 해시
    let fee = 0; // 수수료 전송 fee(bnb)

    ////////////////////////////////
    // Block 체크
    if (profile?.is_block) {
      console.log("🚫 Blocked user's request");

      return new Response(
        JSON.stringify({
          error: "Wrong request",
        }),
        { status: 400, headers }, // bad request
      );
    }

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
          return rejectRequest("Invalid turnstile token");
        }
      }
    } else {
      // 토큰이 없으면 예전 버전이므로 페이지 리로드 필요
      console.log("🚫 No turnstile token: Need page reload");
      return rejectRequest("Need page reload");
    }

    ////////////////////////////////
    // 사용자 검증 (관리자 제외 - 다른 사용자의 금액을 회수하거나 운영지갑 운영 필요)
    if (profile.user_role !== "admin") { // || user.is_super_admin !== true
      // 사용자 검증
      if (profile.username !== from) {
        console.error("🚫 Invalid user");

        // 사용자 차단
        await blockUser(user.id, "Invalid user");

        return new Response(
          JSON.stringify({ error: "Invalid user" }),
          { status: 400, headers },
        );
      }
    }

    ////////////////////////////////
    // 비정상 요청 체크
    if (settings?.enable_transaction_validate_check === "true") {
      const validateResult = validateRequest(requestData, settings);
      if (!validateResult.validated) {
        console.error(
          `🚫 Invalid request: ${profile.username} ${
            validateResult.reason || ""
          }`,
        );

        // 사용자 차단
        await blockUser(user.id, "Invalid user");

        return new Response(
          JSON.stringify({ error: "Invalid request" }),
          { status: 400, headers },
        );
      }
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
          type: type,
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

          // 사용자 차단
          // await blockUser(user.id, "Duplicate request");

          // 텔레그램 메시지 보내기
          sendBlockMessage(
            `🚫 Duplicate request: ${profile.username}`,
          );

          try {
            await supabase.from("debug_logs").insert({
              function_name: "transactions",
              message: "Duplicate request",
              data: { user_id: user.id, username: profile.username },
            });
          } catch (logError) {
            console.error("Error logging:", logError);
          }

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

    ////////////////////////////////
    // 정책 확인
    const isAdmin = profile.user_role === "admin";

    // 관리자는 제한없음
    if (isAdmin) {
      // 관리자 정책확인 : 운영환경에서는 출금 가능 계정만 출금가능
      if (Deno.env.get("ENV") === "production") {
        // 운영
        if (user.email !== "top4035702@gmail.com") {
          console.log("🚫 Withdrawals are temporarily suspended.");
          return rejectRequest("Withdrawals are temporarily suspended.");
        }
      } else {
        // 개발
        if (
          user.email !== "top5702@hanmail.net" &&
          user.email !== "yishin70@gmail.com" &&
          user.email !== "gplanet71@gmail.com"
        ) {
          console.log("🚫 Withdrawals are temporarily suspended.");
          return rejectRequest("Withdrawals are temporarily suspended.");
        }
      }
    } else {
      // 사용자 정책확인 : 기본 사항 체크
      if (
        !settings.wallet_operation || settings.wallet_operation.length !== 42
      ) {
        console.error("Invalid operation wallet");
        return rejectRequest("Invalid operation wallet");
      }

      // 출금 정책 확인
      if (type === "WITHDRAW") {
        // feeding & 노드 보유 유무 체크
        const { data: nodeData, error: nodeError } = await supabase
          .from("mypackages")
          .select("count")
          .eq("user_id", user.id)
          .single();

        const packageCount = nodeData?.count || 0;

        if (profile.feeding === false && packageCount === 0) {
          console.log("User blocked: No feeding and no packages");
          // await blockUser(user.id, "No feeding permission and no packages");

          // return rejectRequest("temporarily suspended.");

          // 사용자 차단은 하지 않고 텔레그램 메시지로 알림만 보내기
          sendBlockMessage(
            `🚫 No feeding and no packages user: ${profile.username}`,
          );
        }

        // 토큰별 출금 활성화 체크
        if (
          (fromToken === "USDT" && settings?.enable_withdraw_usdt !== "true") ||
          (fromToken === "MGG" && settings?.enable_withdraw_mgg !== "true") ||
          (fromToken === "BNB" && settings?.enable_withdraw_bnb !== "true") ||
          (fromToken === "XRP" && settings?.enable_withdraw_xrp !== "true") ||
          (fromToken === "SOL" && settings?.enable_withdraw_sol !== "true")
        ) {
          console.error("Withdrawals are temporarily suspended.");
          return new Response(
            JSON.stringify({
              error: "Withdrawals are temporarily suspended.",
            }),
            { status: 200, headers },
          );
        }
      }

      // 최소 출금/스왑/전송 금액 확인
      const numFromAmount = parseFloat(fromAmount);
      if (
        (type === "WITHDRAW" && fromToken === "USDT" &&
          numFromAmount < settings.minimum_withdraw_usdt) ||
        (type === "WITHDRAW" && fromToken === "MGG" &&
          numFromAmount < settings.minimum_withdraw_mgg) ||
        (type === "WITHDRAW" && fromToken === "BNB" &&
          numFromAmount < settings.minimum_withdraw_bnb) ||
        (type === "WITHDRAW" && fromToken === "XRP" &&
          numFromAmount < settings.minimum_withdraw_xrp) ||
        (type === "WITHDRAW" && fromToken === "SOL" &&
          numFromAmount < settings.minimum_withdraw_sol) ||
        (type === "SWAP" && fromToken === "USDT" && toToken === "MGG" &&
          numFromAmount < settings.minimum_swap_usdt) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "USDT" &&
          numFromAmount < settings.minimum_swap_mgg) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "BNB" &&
          numFromAmount < settings.minimum_swap_mgg_to_bnb) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "XRP" &&
          numFromAmount < settings.minimum_swap_mgg_to_xrp) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "SOL" &&
          numFromAmount < settings.minimum_swap_mgg_to_sol) ||
        (type === "TRANSFER" && fromToken === "USDT" &&
          numFromAmount < settings.minimum_transfer_usdt) ||
        (type === "TRANSFER" && fromToken === "MGG" &&
          numFromAmount < settings.minimum_transfer_mgg)
      ) {
        return new Response(
          JSON.stringify({
            error: "Amount is less than the minimum required.",
          }),
          { status: 200, headers },
        );
      }

      // 출금시 관리자 승인 체크/출금 요청
      if (type === "WITHDRAW") {
        if (fromToken === "USDT") {
          if (parseFloat(settings.minimum_withdraw_usdt) > 0) {
            // 최소 출금 금액 확인
            if (fromAmount < parseFloat(settings?.minimum_withdraw_usdt)) {
              return new Error(
                "Withdrawal amount is less than the minimum required.",
              );
            }

            // 1일이내 출금 금액 확인
            const { data: totalWithdrawals, error } = await supabase.rpc(
              "get_user_usdt_withdrawal_24h",
              {
                userid: user.id,
              },
            );

            if (error) {
              console.error(
                "Error fetching previous withdrawals:",
                error.message,
              );
              return new Error("Request failed: " + error.message);
            }

            // 관리자 승인이 필요한 금액인지 확인
            if (
              parseInt(settings.confirm_over_usdt_amount_day) !== 0 && // USDT 1일 출금금액이 설정되어 있고
              (totalWithdrawals + parseFloat(fromAmount) >
                parseFloat(settings.confirm_over_usdt_amount_day)) // 1일 출금금액이 설정된 금액을 초과하면
            ) {
              // 관리자 승인 요청
              // const { data: transactionData, error: insertError } =
              //   await supabase
              //     .from("transactions")
              //     .insert([
              //       {
              //         user_id: user.id,
              //         from,
              //         from_token: "USDT",
              //         from_amount: fromAmount,
              //         to: to,
              //         status: "CONFIRM",
              //       },
              //     ]);

              // if (insertError) {
              //   console.error(
              //     "Error creating transaction record:",
              //     insertError,
              //   );
              //   return new Response(
              //     JSON.stringify({ error: "Request admin approval" }),
              //     { status: 200, headers },
              //   );
              // }

              // return new Response(
              //   JSON.stringify({ success: true }),
              //   { status: 200, headers },
              // );
              return rejectRequest("Over 24h withdrawal amount");
            }
          }

          // 출금 가능 잔액확인
          if (parseFloat(fromAmount) > wallet.usdt_balance) {
            return rejectRequest("Insufficient balance");
          }
        } else if (fromToken === "MGG") { // MGG 출금 정책 확인
          if (settings?.enable_withdraw_mgg !== "true") {
            return new Response(
              JSON.stringify({
                error: "Withdrawals are temporarily suspended.",
              }),
              { status: 200, headers },
            );
          }

          // 출금 가능 잔액확인
          const fromAddress = await getAddressByUsername(from);
          const mggBalance = await getMggBalance(fromAddress);
          if (parseFloat(fromAmount) > parseFloat(mggBalance)) {
            return rejectRequest("Insufficient balance");
          }
        } else if (fromToken === "BNB") {
          if (settings?.enable_withdraw_bnb !== "true") {
            return new Response(
              JSON.stringify({
                error: "Withdrawals are temporarily suspended.",
              }),
              { status: 200, headers },
            );
          }
        } else if (fromToken === "XRP") { // XRP 출금 정책 확인
          if (settings?.enable_withdraw_xrp !== "true") {
            return new Response(
              JSON.stringify({
                error: "Withdrawals are temporarily suspended.",
              }),
              { status: 200, headers },
            );
          }
          // 출금 가능 잔액확인
          if (parseFloat(fromAmount) > wallet.xrp_balance) {
            return rejectRequest("Insufficient balance");
          }
        } else if (fromToken === "SOL") { // SOL 출금 정책 확인
          if (settings?.enable_withdraw_sol !== "true") {
            return new Response(
              JSON.stringify({
                error: "Withdrawals are temporarily suspended.",
              }),
              { status: 200, headers },
            );
          }
        } else {
          return rejectRequest("Invalid token");
        }
      }

      // 스왑 정책 확인
      if (type === "SWAP") {
        // MGG to USDT, BNB, XRP 스왑 확인
        if (
          fromToken !== "MGG" ||
          (toToken !== "USDT" && toToken !== "BNB" && toToken !== "XRP" &&
            toToken !== "SOL")
        ) {
          return rejectRequest("Invalid token pair");
        }

        // BNB 스왑 정책 확인
        if (toToken === "BNB" && settings?.enable_swap_mgg_to_bnb !== "true") {
          return rejectRequest("Swap to BNB is not enabled");
        }

        // XRP 스왑 정책 확인
        if (toToken === "XRP" && settings?.enable_swap_mgg_to_xrp !== "true") {
          return rejectRequest("Swap to XRP is not enabled");
        }
        // SOL 스왑 정책 확인
        if (toToken === "SOL" && settings?.enable_swap_mgg_to_sol !== "true") {
          return rejectRequest("Swap to SOL is not enabled");
        }
      }
    } // 관리자외 정책 체크 끝

    ////////////////////////////////
    // 요청별 처리
    ////////////////////////////////
    setOperationWallet(settings.wallet_operation); // 수수료를 지급할 지갑 설정

    // 주소 확인
    if (!from || !to) {
      console.error("Invalid request");
      return new Response(
        JSON.stringify({ error: "Invalid request" }),
        { status: 200, headers },
      );
    }

    // 실제 주소 불러오기
    const fromAddress = from.startsWith("sid:")
      ? await getAddressBySid(from.split(":")[1])
      : from.startsWith("0x")
      ? from
      : await getAddressByUsername(from);
    const toAddress = to.startsWith("sid:")
      ? await getAddressBySid(to.split(":")[1])
      : to.startsWith("0x") || (to.startsWith("r") && to.length >= 25) ||
          (type === "WITHDRAW" && fromToken === "SOL")
      ? to
      : await getAddressByUsername(to);

    try {
      // 전송 처리
      if (type === "TRANSFER") { // 내부 사용자에게 전송
        ////////////////////////////////
        // 전송 처리
        ////////////////////////////////
        if (fromToken === "USDT") {
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendUsdt(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            feeAmount = parseFloat(settings.transfer_fee_usdt);
            toAmount = parseFloat(fromAmount) - feeAmount;
            // usdt 전송 (DB)
            const { data, error } = await supabase.rpc("transfer_usdt", {
              from_user: from,
              to_user: to,
              amount: toAmount,
              fee: feeAmount,
            });
            if (error || data?.error) {
              console.error("Error transferring USDT:", error || data?.error);
              txHash = "";
              feeTxHash = "";
            } else {
              txHash = "OK";
              feeTxHash = "";
              feeHash = "OK";
              feeAmount = data.fee;
            }
          }
        } else if (fromToken === "MGG") {
          feeAmount = fromAmount * settings.transfer_fee_rate_mgg /
            100;
          toAmount = fromAmount - feeAmount;

          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendMgg(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
          } else {
            // mgg 전송
            const result = await sendMgg(fromAddress, toAddress, toAmount);
            txHash = result.txHash;

            // 관리자외 수수료 처리
            const feeResult = await sendMgg(
              fromAddress,
              settings.wallet_fee,
              feeAmount.toString(),
            );
            if (feeResult) {
              feeTxHash = feeResult.txHash;
              feeAmount = feeAmount;
            }
          }
        } else if (fromToken === "BNB") {
          // bnb 전송
          if (isAdmin && adminPage) {
            const result = await sendBnb(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            // 사용자의 BNB 전송은 지원하지 않음
            return new Response(
              JSON.stringify({ error: "BNB transfer is not supported" }),
              { status: 400, headers },
            );
          }
        } else {
          // 지원하지 않는 토큰
          return new Response(
            JSON.stringify({ error: "Invalid request" }),
            { status: 400, headers },
          );
        }
      } else if (type === "SWAP") { // SWAP
        ////////////////////////////////
        // 스왑 처리
        ////////////////////////////////
        if (fromToken === "MGG" && toToken === "USDT") {
          // mgg -> usdt 스왑
          exchangeRate = parseFloat(settings.mgg_price_in_usdt); // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg);
          feeAmount = parseFloat(
            (parseFloat(fromAmount) * feeRate / 100).toFixed(8),
          );
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              parseFloat(settings.mgg_price_in_usdt),
          ).toFixed(8);

          // 0. 스왑 금액에 필요한 검증

          // toAmount 금액이 맞는지 확인
          const toAmountVerified = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              exchangeRate,
          ).toFixed(8);
          if (String(toAmountVerified) !== String(toAmount)) {
            return rejectRequest("Invalid amount");
          }

          // 잔액확인
          const mggBalance = await getMggBalance(fromAddress);
          if (parseFloat(fromAmount) > parseFloat(mggBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }
          // 1. 수수료 처리
          const feeResult = await sendMgg(
            fromAddress,
            settings.wallet_fee,
            feeAmount.toString(),
          );
          if (feeResult.success) {
            feeTxHash = feeResult.txHash;
          } else {
            console.error("❗ Error sending MGG fee:", feeResult.error);
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));

          // 2. mgg 토큰을 운영지갑으로 전송 (전송금액)
          const toSendAmount = parseFloat(fromAmount) - parseFloat(feeAmount);
          const result = await sendMgg(
            fromAddress,
            settings.wallet_operation,
            toSendAmount.toString(),
          );
          if (result.success) {
            txHash = result.txHash;
          } else {
            console.error("❗ Error sending MGG:", result.error);
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }

          // 3. usdt 토큰을 wallet.usdt_balance에 잔액을 더해주다
          const { data: walletData, error: updateError } = await supabase
            .rpc("increment_usdt_balance", {
              userid: user.id,
              amount: parseFloat(toAmount),
            });

          if (updateError) {
            console.error("Error updating wallet balance:", updateError);
            return rejectRequest("Failed to update wallet");
          }
        } else if (fromToken === "MGG" && toToken === "BNB") {
          // BNB 스왑 ////////////////////////////////

          // BNB 가격 확인
          let bnbPrice = await getBnbPriceFromBinance(); // 바이낸스 거래소에서 현재 가격 조회 : 650.00 USDT
          if (bnbPrice === 0 || isNaN(bnbPrice)) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1초 대기

            bnbPrice = await getBnbPriceFromBinance(); // 다시 거래 조회
            if (bnbPrice === 0 || isNaN(bnbPrice)) {
              // 2번 실패시 에러 반환
              return rejectRequest("Failed to get BNB price");
            }
          }
          console.log("bnbPrice", bnbPrice);

          // mgg -> bnb 스왑
          exchangeRate = bnbPrice; // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg_to_bnb);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              parseFloat(settings.mgg_price_in_usdt) / bnbPrice,
          ).toFixed(8);

          // 0. 스왑 금액에 필요한 검증

          // toAmount 금액이 맞는지 확인
          // const toAmountVerified = parseFloat(
          //   (parseFloat(fromAmount) - feeAmount) *
          //     exchangeRate / bnbPrice,
          // ).toFixed(8);
          // if (String(toAmountVerified) !== String(toAmount)) {
          //   return rejectRequest("Invalid amount");
          // }

          // MGG 잔액확인
          const mggBalance = await getMggBalance(fromAddress);
          if (parseFloat(fromAmount) > parseFloat(mggBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }
          // 1. mgg 토큰을 운영지갑으로 전송 (전송금액)
          const toSendAmount = parseFloat(fromAmount) - parseFloat(feeAmount);
          const result = await sendMgg(
            fromAddress,
            settings.wallet_operation,
            toSendAmount.toString(),
          );
          if (result.success) {
            txHash = result.txHash;
          } else {
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));

          // 2. 수수료 처리 (mgg를 수수료지갑으로 전송)
          const feeResult = await sendMgg(
            fromAddress,
            settings.wallet_fee,
            feeAmount.toString(),
          );
          feeTxHash = feeResult.txHash;

          // 3. wallet.bnb_balance에 잔액을 더해주다
          const { data: walletData, error: updateError } = await supabase
            .rpc("increment_bnb_balance", {
              userid: user.id,
              amount: parseFloat(toAmount),
            });

          if (updateError) {
            console.error("Error updating wallet balance:", updateError);
            return rejectRequest("Failed to update wallet");
          }

          console.log(
            `🔄 BNB transfer:${toAmount} BNB, price:${bnbPrice}`,
          );
        } else if (fromToken === "MGG" && toToken === "XRP") {
          // XRP 스왑 ////////////////////////////////

          // XRP 가격 확인
          let xrpPrice = await getXrpPriceFromBinance(); // 바이낸스 거래소에서 현재 가격 조회 : 2.4307 USDT
          if (xrpPrice === 0 || isNaN(xrpPrice)) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1초 대기

            xrpPrice = await getXrpPriceFromBinance(); // 다시 거래 조회
            if (xrpPrice === 0 || isNaN(xrpPrice)) {
              // 2번 실패시 에러 반환
              return rejectRequest("Failed to get XRP price");
            }
          }
          console.log("xrpPrice", xrpPrice);

          // mgg -> xrp 스왑
          exchangeRate = xrpPrice; // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg_to_xrp);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              parseFloat(settings.mgg_price_in_usdt) / xrpPrice,
          ).toFixed(8);

          // 0. 스왑 금액에 필요한 검증

          // toAmount 금액이 맞는지 확인
          // const toAmountVerified = parseFloat(
          //   (parseFloat(fromAmount) - feeAmount) *
          //     exchangeRate / bnbPrice,
          // ).toFixed(8);
          // if (String(toAmountVerified) !== String(toAmount)) {
          //   return rejectRequest("Invalid amount");
          // }

          // MGG 잔액확인
          const mggBalance = await getMggBalance(fromAddress);
          if (parseFloat(fromAmount) > parseFloat(mggBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }
          // 1. mgg 토큰을 운영지갑으로 전송 (전송금액)
          const toSendAmount = parseFloat(fromAmount) - parseFloat(feeAmount);
          const result = await sendMgg(
            fromAddress,
            settings.wallet_operation,
            toSendAmount.toString(),
          );
          if (result.success) {
            txHash = result.txHash;
          } else {
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));

          // 2. 수수료 처리 (mgg를 수수료지갑으로 전송)
          const feeResult = await sendMgg(
            fromAddress,
            settings.wallet_fee,
            feeAmount.toString(),
          );
          feeTxHash = feeResult.txHash;

          // 3. wallet.xrp_balance에 잔액을 더해주다
          const { data: walletData, error: updateError } = await supabase
            .rpc("increment_xrp_balance", {
              userid: user.id,
              amount: parseFloat(toAmount),
            });

          if (updateError) {
            console.error("Error updating wallet balance:", updateError);
            return rejectRequest("Failed to update wallet");
          }

          console.log(
            `🔄 XRP transfer:${toAmount} XRP, price:${xrpPrice}`,
          );
        } else if (fromToken === "MGG" && toToken === "SOL") {
          // SOL 스왑 ////////////////////////////////

          // SOL 가격 확인
          let solPrice = await getSolPriceFromBinance(); // 바이낸스 거래소에서 현재 가격 조회 : 2.4307 USDT
          if (solPrice === 0 || isNaN(solPrice)) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1초 대기

            solPrice = await getSolPriceFromBinance(); // 다시 거래 조회
            if (solPrice === 0 || isNaN(solPrice)) {
              // 2번 실패시 에러 반환
              return rejectRequest("Failed to get SOL price");
            }
          }
          console.log("solPrice", solPrice);

          // mgg -> sol 스왑
          exchangeRate = solPrice; // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg_to_sol);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              parseFloat(settings.mgg_price_in_usdt) / solPrice,
          ).toFixed(8);

          // MGG 잔액확인
          const mggBalance = await getMggBalance(fromAddress);
          if (parseFloat(fromAmount) > parseFloat(mggBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }

          // 1. mgg 토큰을 운영지갑으로 전송 (전송금액)
          const toSendAmount = parseFloat(fromAmount) - parseFloat(feeAmount);
          const result = await sendMgg(
            fromAddress,
            settings.wallet_operation,
            toSendAmount.toString(),
          );
          if (result.success) {
            txHash = result.txHash;
          } else {
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));

          // 2. 수수료 처리 (mgg를 수수료지갑으로 전송)
          const feeResult = await sendMgg(
            fromAddress,
            settings.wallet_fee,
            feeAmount.toString(),
          );
          feeTxHash = feeResult.txHash;

          // 3. wallet.xrp_balance에 잔액을 더해주다
          const { data: walletData, error: updateError } = await supabase
            .rpc("increment_sol_balance", {
              userid: user.id,
              amount: parseFloat(toAmount),
            });

          if (updateError) {
            console.error("Error updating wallet balance:", updateError);
            return rejectRequest("Failed to update wallet");
          }

          console.log(
            `🔄 SOL transfer:${toAmount} SOL, price:${solPrice}`,
          );
        } else {
          // MGG -> USDT/BNB/XRP/SOL 스왑이 아닌 경우
          return new Response(
            JSON.stringify({ error: "Invalid request" }),
            { status: 400, headers },
          );
        }
      } else if (type === "DEPOSIT") { // DEPOSIT
        ////////////////////////////////
        // 입금 처리
        ////////////////////////////////
      } else if (type === "WITHDRAW") { // WITHDRAW
        ////////////////////////////////
        // 출금 처리
        ////////////////////////////////
        if (fromToken === "USDT") {
          // USDT 출금 처리
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendUsdt(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            // 사용자 전송
            if (
              parseFloat(settings.withdraw_fee_usdt_per_10000) >
                0
            ) {
              // 수수료 계산
              const feePer10000 = parseFloat(
                settings.withdraw_fee_usdt_per_10000,
              );

              // 10000 USDT 당 수수료 계산
              const units = Math.floor(parseFloat(fromAmount) / 10000) + 1;

              feeAmount = units * feePer10000;
              toAmount = parseFloat(fromAmount) - feeAmount;
            } else {
              // 수수료 없음
              feeAmount = 0;
              toAmount = fromAmount;
            }
            // USDT 출금 처리 : 출금 지갑에서 수수료를 제외한 금액의 USDT를 출금한다.
            // DB에서 사용자의 USDT 잔액에서 출금 금액의 USDT를 차감한다.
            // 수수료 출금 : DB에서 사용자의 USDT 잔액에서 수수료를 차감한다.
            const { data: updateUsdtBalance, error: updateUsdtBalanceError } =
              await supabase
                .rpc("decrease_usdt_balance", {
                  userid: user.id,
                  amount: parseFloat(fromAmount),
                });
            if (updateUsdtBalanceError) {
              console.error(
                "Error updating USDT balance:",
                updateUsdtBalanceError,
              );
            }
            // 토큰을 전송한다.
            const result = await sendUsdt(
              settings.wallet_withdraw,
              toAddress,
              toAmount,
            );
            if (result.success) {
              txHash = result.txHash;
            } else {
              // 토큰 전송 실패시 잔액 복구
              const { data: updateUsdtBalance, error: updateUsdtBalanceError } =
                await supabase
                  .rpc("increment_usdt_balance", {
                    userid: user.id,
                    amount: parseFloat(fromAmount),
                  });
              if (updateUsdtBalanceError) {
                console.error(
                  "Error updating USDT balance:",
                  updateUsdtBalanceError,
                );
              }
              return rejectRequest("Transaction failed");
            }
          }
        } else if (fromToken === "MGG") {
          // mgg 출금
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendMgg(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            if (parseFloat(settings.withdraw_fee_rate_mgg) > 0) {
              feeAmount = parseFloat(fromAmount) *
                parseFloat(settings.withdraw_fee_rate_mgg) /
                100;
              toAmount = parseFloat(fromAmount) - feeAmount;
            } else {
              feeAmount = 0;
              toAmount = fromAmount;
            }
            const result = await sendMgg(fromAddress, toAddress, toAmount);
            txHash = result.txHash;

            // mgg fee 출금처리
            if (parseFloat(settings.withdraw_fee_rate_mgg) > 0) {
              const resultFee = await sendMgg(
                fromAddress,
                settings.wallet_fee,
                feeAmount,
              );
              feeTxHash = resultFee.txHash;
            }
          }
        } else if (fromToken === "BNB") {
          // bnb 출금
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendBnb(fromAddress, toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            // 사용자 전송
            if (
              parseFloat(settings.withdraw_fee_rate_bnb) >
                0
            ) {
              feeAmount = parseFloat(fromAmount) *
                parseFloat(settings.withdraw_fee_rate_bnb) /
                100;
              toAmount = parseFloat(fromAmount) - feeAmount;
            } else {
              // 수수료 없음
              feeAmount = 0;
              toAmount = fromAmount;
            }
            // BNB 출금 처리 : 출금 지갑에서 수수료를 제외한 금액의 BNB를 출금한다.
            // DB에서 사용자의 BNB 잔액에서 출금 금액의 BNB를 차감한다.
            // 수수료 출금 : DB에서 사용자의 BNB 잔액에서 수수료를 차감한다.
            const { data: updateBnbBalance, error: updateBnbBalanceError } =
              await supabase
                .rpc("decrease_bnb_balance", {
                  userid: user.id,
                  amount: parseFloat(fromAmount),
                });
            if (updateBnbBalanceError) {
              console.error(
                "Error updating BNB balance:",
                updateBnbBalanceError,
              );
            }
            // 토큰을 전송한다.
            const result = await sendBnb(
              settings.wallet_withdraw,
              toAddress,
              toAmount,
            );
            if (result.success) {
              txHash = result.txHash;
            } else {
              // 토큰 전송 실패시 잔액 복구
              const { data: updateBnbBalance, error: updateBnbBalanceError } =
                await supabase
                  .rpc("increment_bnb_balance", {
                    userid: user.id,
                    amount: parseFloat(fromAmount),
                  });
              if (updateBnbBalanceError) {
                console.error(
                  "Error updating BNB balance:",
                  updateBnbBalanceError,
                );
              }
              return rejectRequest("Transaction failed");
            }
          }
        } else if (fromToken === "XRP") {
          const xrpBalance = await getXrpBalance(""); // 출금 지갑의 XRP 잔액 확인
          if (parseFloat(fromAmount) > parseFloat(xrpBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }

          // xrp 출금
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendXrp(
              fromAddress,
              toAddress,
              fromAmount,
              destinationTag,
            );
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            // 사용자 전송
            if (
              parseFloat(settings.withdraw_fee_rate_xrp) >
                0
            ) {
              feeAmount = parseFloat(fromAmount) *
                parseFloat(settings.withdraw_fee_rate_xrp) /
                100;
              toAmount = parseFloat(fromAmount) - feeAmount;
            } else {
              // 수수료 없음
              feeAmount = 0;
              toAmount = fromAmount;
            }
            // XRP 출금 처리 : 출금 지갑에서 수수료를 제외한 금액의 XRP를 출금한다.
            // DB에서 사용자의 XRP 잔액에서 출금 금액의 XRP를 차감한다.
            // 수수료 출금 : DB에서 사용자의 XRP 잔액에서 수수료를 차감한다.
            const { data: updateXrpBalance, error: updateXrpBalanceError } =
              await supabase
                .rpc("decrease_xrp_balance", {
                  userid: user.id,
                  amount: parseFloat(fromAmount),
                });
            if (updateXrpBalanceError) {
              console.error(
                "Error updating XRP balance:",
                updateXrpBalanceError,
              );
            }
            // 토큰을 전송한다.
            const result = await sendXrp(
              "",
              toAddress,
              toAmount,
              destinationTag,
            );
            if (result.success) {
              txHash = result.txHash;
            } else {
              // 토큰 전송 실패시 잔액 복구
              const { data: updateXrpBalance, error: updateXrpBalanceError } =
                await supabase
                  .rpc("increment_xrp_balance", {
                    userid: user.id,
                    amount: parseFloat(fromAmount),
                  });
              if (updateXrpBalanceError) {
                console.error(
                  "Error updating XRP balance:",
                  updateXrpBalanceError,
                );
              }
              return rejectRequest("Transaction failed");
            }
          }
        } else if (fromToken === "SOL") {
          const solBalance = await getSolBalance(""); // 출금 지갑의 SOL 잔액 확인
          if (parseFloat(fromAmount) > parseFloat(solBalance)) {
            return new Response(
              JSON.stringify({ error: "Insufficient balance" }),
              { status: 400, headers },
            );
          }

          // sol 출금
          if (isAdmin && adminPage) {
            // 관리자 전송
            const result = await sendSol(toAddress, fromAmount);
            txHash = result.txHash;
            feeTxHash = result.feeTxHash;
          } else {
            // 사용자 전송
            if (
              parseFloat(settings.withdraw_fee_rate_sol) >
                0
            ) {
              feeAmount = parseFloat(fromAmount) *
                parseFloat(settings.withdraw_fee_rate_sol) /
                100;
              toAmount = parseFloat(fromAmount) - feeAmount;
            } else {
              // 수수료 없음
              feeAmount = 0;
              toAmount = fromAmount;
            }
            // SOL 출금 처리 : 출금 지갑에서 수수료를 제외한 금액의 SOL를 출금한다.
            // DB에서 사용자의 SOL 잔액에서 출금 금액의 SOL를 차감한다.
            // 수수료 출금 : DB에서 사용자의 SOL 잔액에서 수수료를 차감한다.
            const { data: updateSolBalance, error: updateSolBalanceError } =
              await supabase
                .rpc("decrease_sol_balance", {
                  userid: user.id,
                  amount: parseFloat(fromAmount),
                });
            if (updateSolBalanceError) {
              console.error(
                "Error updating SOL balance:",
                updateSolBalanceError,
              );
            }
            // 토큰을 전송한다.
            const result = await sendSol(
              toAddress,
              toAmount,
            );
            if (result.success) {
              txHash = result.txHash;
            } else {
              // 토큰 전송 실패시 잔액 복구
              const { data: updateSolBalance, error: updateSolBalanceError } =
                await supabase
                  .rpc("increment_sol_balance", {
                    userid: user.id,
                    amount: parseFloat(fromAmount),
                  });
              if (updateSolBalanceError) {
                console.error(
                  "Error updating SOL balance:",
                  updateSolBalanceError,
                );
                return rejectRequest("Transaction failed");
              }
            }
          }
        }
      } else {
        // 에러
        return new Response(
          JSON.stringify({ error: "Invalid request" }),
          { status: 200, headers },
        );
      }
    } catch (error) {
      console.error("Unexpected error:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    } finally {
      ////////////////////////////////
      // 트랜잭션 기록 생성
      try {
        const txData = {
          user_id: user.id,
          transaction_type: type,
          from: from,
          from_token: fromToken,
          from_amount: fromAmount,
          to: to,
          to_token: toToken,
          to_amount: toAmount,
          tx_hash: txHash,
          exchange_rate: exchangeRate,
          status: txHash ? "COMPLETED" : "FAILED",
          fee_rate: feeRate,
          fee_amount: feeAmount,
          fee_tx_hash: feeTxHash,
          destination_tag: destinationTag,
        };
        const { data: transactionData, error: insertError } = await supabase
          .from("transactions")
          .insert([txData])
          .select()
          .single();

        if (insertError) {
          console.error("Error creating transaction record:", insertError);
        }

        // 전송 성공 회신
        if (txHash) {
          const typeText = type === "TRANSFER"
            ? "🔀 내부 이체"
            : type === "SWAP"
            ? "🔄 스왑 "
            : type === "WITHDRAW"
            ? "✈️ 외부 출금"
            : type === "DEPOSIT"
            ? "💰 외부 입금"
            : "ℹ️ 기타";

          let message = `━━━━━━━━━━━━━━━\n${typeText}${
            from === to ? from : ""
          }\nFrom: ${
            (to !== from) ? (from ? from : fromAddress) : ""
          }\n${fromToken} ${fromAmount}\nTo: ${
            (to !== from) ? (to ? to : toAddress) : ""
          }\n${toToken || ""} ${toAmount || ""}`;

          if (type === "WITHDRAW" && fromToken !== "MGG") {
            // 출금에 성공하면 출금용 지갑의 잔액 조회
            const tokenBalance = fromToken === "XRP"
              ? await getXrpBalance("")
              : fromToken === "SOL"
              ? await getSolBalance("")
              : fromToken === "BNB"
              ? await getBnbBalance(settings.wallet_withdraw)
              : await getUsdtBalance(settings.wallet_withdraw);

            const tokenBalanceText = fromToken === "XRP"
              ? parseFloat(tokenBalance).toLocaleString("en-US", {
                minimumFractionDigits: 6,
                maximumFractionDigits: 6,
              })
              : fromToken === "SOL"
              ? parseFloat(tokenBalance).toLocaleString("en-US", {
                minimumFractionDigits: 9,
                maximumFractionDigits: 9,
              })
              : fromToken === "BNB"
              ? parseFloat(tokenBalance).toLocaleString("en-US", {
                minimumFractionDigits: 8,
                maximumFractionDigits: 8,
              })
              : parseFloat(tokenBalance).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });

            message += `\n\n> 운영 잔액: ${tokenBalanceText} ${fromToken}`;
          }
          await sendTelegramMessage(message);

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
        console.error("Error creating transaction record:", error);
      }
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 200, headers },
    );
  }
});

function rejectRequest(reason?: string) {
  console.error("🚫 Policy violation:", reason);

  return new Response(
    JSON.stringify({
      error: "Policy violation",
      reason: reason || "Policy violation",
    }),
    { status: 200 },
  );
}

async function blockUser(userId: string, reason: string) {
  const { data: userData, error: userError } = await supabase
    .from("profiles")
    .update({ is_block: true, block_reason: reason })
    .eq("user_id", userId)
    .select("username")
    .single();

  if (userError) {
    console.error("Error blocking user:", userError);

    await sendBlockMessage(
      `🚫 사용자 차단 실패: ${userData?.username}(${userId}) ${userError.message}`,
    );
    return;
  }

  await sendBlockMessage(
    `🚫 사용자 차단: ${userData?.username} (${userId}) ${reason}`,
  );
}

/**
 * 요청 데이터 검증
 * @param requestData 요청 데이터
 * @returns 검증 결과, 이후 검증에 실패한 경우 사용자는 차단됨
 *
 * 검증 결과
 * {
 *   validated: boolean,
 *   reason: string
 * }
 */

function validateRequest(requestData: any, settings: any) {
  const { type, from, to, fromToken, toToken, fromAmount, toAmount } =
    requestData;

  // 요청 데이터 검증
  if (!from || !to || !fromToken || !fromAmount) { // !toToken, toAmount 은 출금시 null 가능
    return { validated: false, reason: "Invalid request" };
  }

  // 공통 : 금액 데이터 검증
  // 숫자 형식 검증
  if (isNaN(parseFloat(fromAmount)) || isNaN(parseFloat(toAmount))) {
    return { validated: false, reason: "Invalid amount" };
  }
  // 0 이상 검증
  if (parseFloat(fromAmount) <= 0) {
    return { validated: false, reason: "Invalid amount" };
  }

  // 0 이상 검증
  if (parseFloat(toAmount) <= 0) {
    return { validated: false, reason: "Invalid amount" };
  }

  ////////////////////////////////
  // SWAP 요청 검증
  if (type === "SWAP") {
    // 토큰 쌍 검증
    if (fromToken !== "MGG" || (toToken !== "USDT" && toToken !== "BNB")) {
      return { validated: false, reason: "[SWAP] Invalid token pair" };
    }

    // 최소 스왑 금액 검증
    if (
      fromToken === "MGG" &&
      parseFloat(fromAmount) < parseFloat(settings.minimum_swap_mgg)
    ) {
      return { validated: false, reason: "[SWAP] Minimum swap amount" };
    }

    // 스왑 금액 확인
    const feeAmount = parseFloat(fromAmount) *
      parseFloat(settings.swap_fee_rate_mgg) / 100;
    const swapAmount = (parseFloat(fromAmount) - feeAmount) *
      parseFloat(settings.mgg_price_in_usdt);
    if (swapAmount !== parseFloat(toAmount)) {
      return { validated: false, reason: "[SWAP] Maximum swap amount" };
    }
  }

  ////////////////////////////////
  // TRANSFER 요청 검증
  if (type === "TRANSFER") {
    // 토큰 쌍 검증
    if (fromToken !== "MGG" && fromToken !== "USDT") {
      return { validated: false, reason: "[TRANSFER] Invalid token pair" };
    }

    // 최소 전송 금액 확인
    if (
      (fromToken === "MGG" &&
        (parseFloat(fromAmount) < parseFloat(settings.minimum_transfer_mgg))) ||
      (fromToken === "USDT" &&
        (parseFloat(fromAmount) < parseFloat(settings.minimum_transfer_usdt)))
    ) {
      return { validated: false, reason: "[TRANSFER] Minimum transfer amount" };
    }
  }

  ////////////////////////////////
  // WITHDRAW 요청 검증
  if (type === "WITHDRAW") {
    // 토큰 쌍 검증
    if (fromToken !== "MGG" && fromToken !== "USDT") {
      return { validated: false, reason: "[WITHDRAW] Invalid token pair" };
    }

    // 최소 출금 금액 확인
    if (
      (fromToken === "MGG" &&
        (parseFloat(fromAmount) < parseFloat(settings.minimum_withdraw_mgg))) ||
      (fromToken === "USDT" &&
        (parseFloat(fromAmount) < parseFloat(settings.minimum_withdraw_usdt)))
    ) {
      return { validated: false, reason: "[WITHDRAW] Minimum withdraw amount" };
    }
  }

  // 검증 성공
  return { validated: true, reason: "validate success" };
}
