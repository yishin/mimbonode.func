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
import { authenticateRequest, getSettings } from "../utils/authUtils.ts";
import {
  completeFunctionCall,
  failFunctionCall,
  trackFunctionCall,
} from "../utils/trackUtils.ts";

// Edge Function 시작
serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 현재 날짜 정보 가져오기
  const now = new Date();
  const lastMonth = new Date(now);
  lastMonth.setMonth(now.getMonth() - 1);

  const year = lastMonth.getFullYear();
  const month = lastMonth.getMonth() + 1; // JavaScript에서 월은 0부터 시작

  // 지난달의 시작일과 종료일 계산
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);

  // 함수 호출 파라미터
  const functionParams = {
    period: `${year}-${month.toString().padStart(2, "0")}`,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };

  // 함수 호출 추적 시작
  const callId = await trackFunctionCall(
    "special-bonus",
    functionParams,
  );

  // 메타데이터 초기화
  const metadata = {
    start_time: new Date().toISOString(),
    period: `${year}-${month}`,
    description: `Special bonus for ${year}-${month}`,
  };

  console.log(
    `Processing rewards for period: ${startDate.toISOString()} to ${endDate.toISOString()}`,
  );
  console.log(`Function call tracked with ID: ${callId}`);

  // 결과 추적을 위한 변수들
  let result = {};
  let totalRewardAmount = 0;
  let totalUsersRewarded = 0;
  const levelStats = {};

  try {
    //
    const settings = await getSettings();
    setOperationWallet(settings.wallet_operation);

    // 1달이내 실행한 이력이 있는지 확인
    const { data: lastExecution, error: lastExecutionError } = await supabase
      .from("edge_function_calls")
      .select("count")
      .eq("function_name", "special-bonus")
      .eq("status", "completed")
      .gte("started_at", endDate.toISOString());

    if (lastExecutionError) {
      console.error("Error fetching last execution:", lastExecutionError);
    }

    if (lastExecution?.[0]?.count > 0) {
      console.log("Last execution found for this period");
      throw new Error("Last execution found for this period");
    }

    // 각 레벨(1-6)에 대해 처리
    for (let level = 4; level <= 6; level++) {
      console.log(`Processing level ${level}...`);

      // 1. 해당 레벨의 지난달 mining 총액 계산
      const { data: miningData, error: miningError } = await supabase
        .from("mining")
        .select("amount")
        .eq("user_level", level)
        .gte("created_at", startDate.toISOString())
        .lt("created_at", endDate.toISOString());

      if (miningError) {
        console.error(
          `Error fetching mining data for level ${level}:`,
          miningError,
        );
        levelStats[`level_${level}`] = { error: miningError.message };
        continue;
      }

      // 총 마이닝 금액 계산
      const totalAmount = miningData.reduce(
        (sum, item) => sum + (item.amount || 0),
        0,
      );
      console.log(`Total mining amount for level ${level}: ${totalAmount}`);

      // 보상 금액 계산 (총액의 1%)
      const rewardAmount = totalAmount * 0.01;
      console.log(`Reward amount (1%): ${rewardAmount}`);

      if (rewardAmount <= 0) {
        console.log(`No rewards to distribute for level ${level}`);
        levelStats[`level_${level}`] = {
          totalAmount: totalAmount,
          rewardAmount: 0,
          userCount: 0,
          status: "no_rewards",
        };
        continue;
      }

      // 2. 해당 레벨의 사용자 수 계산
      const { data: users, error: usersError } = await supabase
        .from("mining")
        .select("user_id")
        .eq("user_level", level);

      if (usersError) {
        console.error(`Error fetching users for level ${level}:`, usersError);
        levelStats[`level_${level}`] = {
          totalAmount: totalAmount,
          rewardAmount: rewardAmount,
          error: usersError.message,
        };
        continue;
      }
      const uniqueUserIds = new Set();
      users?.forEach((item) => {
        uniqueUserIds.add(item.user_id);
      });

      const userCount = uniqueUserIds.size;
      console.log(`Number of users at level ${level}: ${userCount}`);

      if (userCount === 0) {
        console.log(`No users to distribute rewards for level ${level}`);
        levelStats[`level_${level}`] = {
          totalAmount: totalAmount,
          rewardAmount: rewardAmount,
          userCount: 0,
          status: "no_users",
        };
        continue;
      }

      // 3. 사용자당 보상 금액 계산
      const rewardPerUser = rewardAmount / userCount;
      console.log(`Reward per user: ${rewardPerUser}`);

      // 레벨 통계 초기화
      levelStats[`level_${level}`] = {
        totalAmount: totalAmount,
        rewardAmount: rewardAmount,
        userCount: userCount,
        rewardPerUser: rewardPerUser,
        successCount: 0,
        failCount: 0,
        users: [],
      };

      // 4. 각 사용자에게 보상 지급
      for (const userid of uniqueUserIds) {
        console.log(`Sending ${rewardPerUser} MGG to user ${userid}`);

        try {
          const { data: userData, error: userError } = await supabase
            .from("wallets")
            .select("address")
            .eq("user_id", userid)
            .single();

          if (userError) {
            console.error(
              `Error fetching user data for user ${userid}:`,
              userError,
            );
            continue;
          }

          const toAddress = userData.address;
          // sendMgg 함수 호출하여 토큰 전송
          const { success } = await sendMgg(
            settings.wallet_operation,
            toAddress,
            rewardPerUser,
          );

          if (!success) {
            console.error(`Error sending MGG to user ${userid}:`);
            levelStats[`level_${level}`].failCount++;
            levelStats[`level_${level}`].users.push({
              user_id: userid,
              status: "failed",
              error: sendError.message,
            });
            continue;
          }

          console.log(
            `Successfully sent MGG to user ${userid}:`,
            rewardPerUser,
          );
          levelStats[`level_${level}`].successCount++;
          totalUsersRewarded++;
          totalRewardAmount += rewardPerUser;

          // 사용자 통계 추가
          levelStats[`level_${level}`].users.push({
            user_id: userid,
            status: "success",
            amount: rewardPerUser,
          });

          // 커미션 기록 저장
          const { error: commissionError } = await supabase
            .from("commissions")
            .insert({
              user_id: userid,
              type: "special bonus",
              wallet: "MGG",
              amount: rewardPerUser,
              message: `Speical bonus for level ${level} (${year}-${month})`,
              total_amount: rewardAmount,
              person_count: userCount,
            });

          if (commissionError) {
            console.error(
              `Error recording commission for user ${userid}:`,
              commissionError,
            );
          }
        } catch (userError) {
          console.error(`Exception processing user ${userid}:`, userError);
          levelStats[`level_${level}`].failCount++;
          levelStats[`level_${level}`].users.push({
            user_id: user.id,
            status: "error",
            error: userError.message,
          });
        }
      }

      console.log(`Completed processing for level ${level}`);
    }

    // 결과 객체 생성
    result = {
      success: true,
      totalRewardAmount,
      totalUsersRewarded,
      levelStats,
    };
    // 함수 호출 완료 추적
    await completeFunctionCall(callId, result, {
      ...metadata,
      totalRewardAmount,
      totalUsersRewarded,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Special bonus distributed successfully",
        callId: callId,
        totalRewardAmount: totalRewardAmount,
        totalUsersRewarded: totalUsersRewarded,
      }),
      {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    console.error("Error processing special bonus:", error);

    // 함수 호출 실패 추적
    await failFunctionCall(callId, error, metadata);

    return new Response(
      JSON.stringify({ success: false, error: error.message, callId: callId }),
      {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
