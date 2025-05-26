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
  sendBnb,
  sendMgg,
  sendUsdt,
  setOperationWallet,
} from "../utils/tokenUtils.ts";
import { getXrpBalance, sendXrp } from "../utils/xrpUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";
import {
  getBnbPriceFromBinance,
  getXrpPriceFromBinance,
} from "../utils/exchangeUtils.ts";
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
      adminPage, // 관리자 페이지 여부
    } = requestData;
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

    ////////////////////////////////
    // 사용자 검증 (관리자 제외 - 다른 사용자의 금액을 회수하거나 운영지갑 운영 필요)
    if (profile.user_role !== "admin") { // || user.is_super_admin !== true
      // 사용자 검증
      if (profile.user_id !== user.id) {
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
    if (!isAdmin) {
      // 기본 사항 체크
      if (
        !settings.wallet_operation || settings.wallet_operation.length !== 42
      ) {
        console.error("Invalid operation wallet");
        return rejectRequest("Invalid operation wallet");
      }

      // 출금 정책 확인
      if (type === "WITHDRAW") {
        if (
          (fromToken === "USDT" && settings.enable_withdraw_usdt !== "true") ||
          (fromToken === "MGG" && settings.enable_withdraw_mgg !== "true") ||
          (fromToken === "BNB" && settings.enable_withdraw_bnb !== "true")
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
        (type === "SWAP" && fromToken === "USDT" && toToken === "MGG" &&
          numFromAmount < settings.minimum_swap_usdt) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "USDT" &&
          numFromAmount < settings.minimum_swap_mgg) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "BNB" &&
          numFromAmount < settings.minimum_swap_mgg_to_bnb) ||
        (type === "SWAP" && fromToken === "MGG" && toToken === "XRP" &&
          numFromAmount < settings.minimum_swap_mgg_to_xrp) ||
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
        if (fromToken === "USDT" && settings.minimum_withdraw_usdt > 0) {
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

          if (toAmount < parseFloat(settings.minimum_withdraw_usdt)) {
            // 허용금액 미달
            return new Error(
              "Withdrawal amount is less than the minimum required.",
            );
          }
          // 출금 가능 잔액확인
          if (wallet.usdt_balance < parseFloat(fromAmount)) {
            return rejectRequest("Insufficient balance");
          }

          // 관리자 승인이 필요한 금액인지 확인
          if (
            totalWithdrawals + parseFloat(fromAmount) >
              parseFloat(settings.confirm_over_usdt_amount_day)
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
                JSON.stringify({ error: "Request admin approval" }),
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

      // 스왑 정책 확인
      if (type === "SWAP") {
        if (
          fromToken !== "MGG" ||
          (toToken !== "USDT" && toToken !== "BNB" && toToken !== "XRP")
        ) {
          return rejectRequest("Invalid token pair");
        }

        if (toToken === "BNB" && settings.enable_swap_mgg_to_bnb !== "true") {
          return rejectRequest("Swap to BNB is not enabled");
        }
        if (toToken === "XRP" && settings.enable_swap_mgg_to_xrp !== "true") {
          return rejectRequest("Swap to XRP is not enabled");
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
      : to.startsWith("0x") || to.startsWith("r")
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
          const result = await sendBnb(fromAddress, toAddress, fromAmount);
          txHash = result.txHash;
          feeTxHash = result.feeTxHash;
        }
      } else if (type === "SWAP") { // SWAP
        ////////////////////////////////
        // 스왑 처리
        ////////////////////////////////
        if (fromToken === "MGG" && toToken === "USDT") {
          // mgg -> usdt 스왑
          exchangeRate = parseFloat(settings.mgg_price_in_usdt); // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
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
            console.error("❗ Error sending MGG:", result.error);
            return new Response(
              JSON.stringify({ error: "Transaction failed" }),
              { status: 400, headers },
            );
          }
          // 2. 수수료 처리
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
          const bnbPrice = await getBnbPriceFromBinance(); // 바이낸스 거래소에서 현재 가격 조회 : 650.00 USDT
          if (bnbPrice === 0) {
            return rejectRequest("Failed to get BNB price");
          }

          // mgg -> bnb 스왑
          exchangeRate = parseFloat(settings.mgg_price_in_usdt); // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg_to_bnb);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              exchangeRate / bnbPrice,
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
          const xrpPrice = await getXrpPriceFromBinance(); // 바이낸스 거래소에서 현재 가격 조회 : 2.4307 USDT
          if (xrpPrice === 0) {
            return rejectRequest("Failed to get XRP price");
          }

          // mgg -> xrp 스왑
          exchangeRate = parseFloat(settings.mgg_price_in_usdt); // tx 기록용
          feeRate = parseFloat(settings.swap_fee_rate_mgg_to_xrp);
          feeAmount = (parseFloat(fromAmount) * feeRate / 100)
            .toFixed(8);
          toAmount = parseFloat(
            (parseFloat(fromAmount) - feeAmount) *
              exchangeRate / xrpPrice,
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
        } else {
          // MGG -> USDT/BNB/XRP 스왑이 아닌 경우
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
            const result = await sendXrp(fromAddress, toAddress, fromAmount);
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

          const message = `━━━━━━━━━━━━━━━\n${typeText}${
            from === to ? from : ""
          }\nFrom: ${
            (to !== from) ? (from ? from : fromAddress) : ""
          }\n${fromToken} ${fromAmount}\nTo: ${
            (to !== from) ? (to ? to : toAddress) : ""
          }\n${toToken || ""} ${toAmount || ""}`;
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
    .eq("user_id", userId);

  if (userError) {
    console.error("Error blocking user:", userError);

    const { data: userData, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .single();

    await sendTelegramMessage(
      `🚫 사용자 차단 실패: ${userData?.username}(${userId}) ${userError.message}`,
    );
    return;
  }

  await sendTelegramMessage(`🚫 사용자 차단: ${userData?.username} ${reason}`);
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
