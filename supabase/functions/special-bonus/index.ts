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
import { sendTelegramMessage } from "../utils/telegramUtils.ts";

// Edge Function 시작
serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // 함수 호출 추적 시작
  const callId = await trackFunctionCall(
    "special-bonus",
    { description: "Special bonus distribution" },
  );

  // 메타데이터 초기화
  const metadata = {
    start_time: new Date().toISOString(),
    description: "Special bonus distribution",
  };

  console.log("Starting special bonus distribution...");
  console.log(`Function call tracked with ID: ${callId}`);

  // 결과 추적을 위한 변수들
  let result: any = {};
  let totalRewardAmount = 0;
  let totalUsersRewarded = 0;
  const levelStats: any = {};

  try {
    const settings = await getSettings();
    setOperationWallet(settings.wallet_operation);

    // 1. RPC 함수를 사용하여 이전달의 mining 합계 구하기
    const { data: miningSum, error: miningSumError } = await supabase
      .rpc("sum_mining_early_month");

    if (miningSumError) {
      console.error("Error fetching mining sum:", miningSumError);
      throw new Error(`Failed to fetch mining sum: ${miningSumError.message}`);
    }

    if (!miningSum || miningSum.length === 0) {
      throw new Error("No mining data found for last month");
    }

    const miningData = miningSum[0];
    const totalMiningAmount = parseFloat(miningData.total_amount) || 0;
    const period = miningData.period;
    const startDate = miningData.start_date;
    const endDate = miningData.end_date;

    console.log(`Mining data for period ${period}:`);
    console.log(`Total mining amount: ${totalMiningAmount}`);
    console.log(`Period: ${startDate} to ${endDate}`);

    // 2. 이번달에 이미 실행된 이력이 있는지 확인
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const { data: lastExecution, error: lastExecutionError } = await supabase
      .from("edge_function_calls")
      .select("*")
      .eq("function_name", "special-bonus")
      .eq("status", "completed")
      .gte("started_at", thisMonthStart.toISOString())
      .lt("started_at", nextMonthStart.toISOString());

    if (lastExecutionError) {
      console.error("Error checking last execution:", lastExecutionError);
    }

    if (lastExecution && lastExecution.length > 0) {
      console.log("Special bonus already executed for this period");
      throw new Error("Special bonus already executed for this period");
    }

    // 3. 각 레벨별 보상 금액 계산 (전체 mining 합계의 1%씩)
    const rewardAmountPerLevel = totalMiningAmount * 0.01;
    console.log(`Reward amount per level (1%): ${rewardAmountPerLevel}`);

    if (rewardAmountPerLevel <= 0) {
      throw new Error("No rewards to distribute");
    }

    // 4. 각 레벨(4,5,6)의 사용자 조회 및 보상 지급
    const targetLevels = [4, 5, 6];

    for (const level of targetLevels) {
      console.log(`Processing level ${level}...`);

      // 해당 레벨의 사용자들 조회
      const { data: levelUsers, error: levelUsersError } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("user_level", level);

      if (levelUsersError) {
        console.error(
          `Error fetching users for level ${level}:`,
          levelUsersError,
        );
        levelStats[`level_${level}`] = {
          userCount: 0,
          status: "error",
          error: levelUsersError.message,
          successCount: 0,
          failCount: 0,
        };
        continue;
      }

      const userCount = levelUsers?.length || 0;
      console.log(`Level ${level}: ${userCount} users`);

      if (userCount === 0) {
        console.log(`No users found for level ${level}`);
        levelStats[`level_${level}`] = {
          userCount: 0,
          status: "no_users",
          successCount: 0,
          failCount: 0,
        };
        continue;
      }

      // 레벨별 사용자당 보상 금액 계산
      const rewardPerUser = rewardAmountPerLevel / userCount;
      console.log(`Level ${level} reward per user: ${rewardPerUser}`);

      // 레벨 통계 초기화
      levelStats[`level_${level}`] = {
        userCount: userCount,
        rewardPerLevel: rewardAmountPerLevel,
        rewardPerUser: rewardPerUser,
        successCount: 0,
        failCount: 0,
        users: [],
      };

      // 각 사용자에게 보상 지급
      for (const userRecord of levelUsers) {
        const userId = userRecord.user_id;
        console.log(
          `Adding ${rewardPerUser} to matching bonus for user ${userId} (level ${level})`,
        );

        try {
          // profiles 테이블의 matching_bonus 업데이트
          const { error: profileUpdateError } = await supabase.rpc(
            "increment_matching_bonus",
            {
              username: "",
              userid: userId,
              amount: rewardPerUser,
              bonus_rate: 1,
              mining_total: rewardAmountPerLevel,
              transfer_amount: rewardPerUser,
            },
          );

          if (profileUpdateError) {
            console.error(
              `Error updating matching_bonus for user ${userId}:`,
              profileUpdateError,
            );
            levelStats[`level_${level}`].failCount++;
            levelStats[`level_${level}`].users.push({
              user_id: userId,
              status: "failed",
              error: profileUpdateError.message,
            });
            continue;
          }

          console.log(
            `Successfully updated matching bonus for user ${userId}: +${rewardPerUser}`,
          );
          levelStats[`level_${level}`].successCount++;
          totalUsersRewarded++;
          totalRewardAmount += rewardPerUser;

          // 사용자 통계 추가
          levelStats[`level_${level}`].users.push({
            user_id: userId,
            status: "success",
            amount: rewardPerUser,
          });

          // 커미션 기록 저장
          const { error: commissionError } = await supabase
            .from("commissions")
            .insert({
              user_id: userId,
              type: "special bonus",
              wallet: "MGG",
              amount: rewardPerUser,
              message: `Special bonus for level ${level} (${period})`,
              total_amount: rewardAmountPerLevel,
              person_count: userCount,
            });

          if (commissionError) {
            console.error(
              `Error recording commission for user ${userId}:`,
              commissionError,
            );
          }
        } catch (userError) {
          console.error(`Exception processing user ${userId}:`, userError);
          levelStats[`level_${level}`].failCount++;
          levelStats[`level_${level}`].users.push({
            user_id: userId,
            status: "error",
            error: userError instanceof Error
              ? userError.message
              : "Unknown error",
          });
        }
      }

      console.log(`Completed processing for level ${level}`);
    }

    // 결과 객체 생성
    result = {
      success: true,
      period,
      totalMiningAmount,
      rewardAmountPerLevel,
      totalRewardAmount,
      totalUsersRewarded,
      levelStats,
    };

    // 텔레그램으로 결과 전송
    let telegramMessage = `🎉 **특별 보너스 지급 완료**\n\n`;
    telegramMessage += `📅 **기간**: ${period}\n`;
    telegramMessage += `⛏️ **총 채굴량**: ${
      totalMiningAmount.toFixed(2)
    } MGG\n`;
    telegramMessage += `💰 **레벨별 지급량**: ${
      rewardAmountPerLevel.toFixed(2)
    } POINT (1%)\n`;
    telegramMessage += `👥 **총 지급 사용자**: ${totalUsersRewarded}명\n`;
    telegramMessage += `💸 **총 지급액**: ${
      totalRewardAmount.toFixed(2)
    } POINT\n\n`;

    telegramMessage += `📊 **레벨별 지급 현황**:\n`;
    for (const level of [4, 5, 6]) {
      const stats = levelStats[`level_${level}`];
      if (stats) {
        telegramMessage += `\n🔹 **Level ${level}**\n`;
        telegramMessage += `   👤 사용자 수: ${stats.userCount}명\n`;
        if (stats.userCount > 0) {
          telegramMessage += `   💎 개별 지급액: ${
            stats.rewardPerUser?.toFixed(4)
          } POINT\n`;
        }
        telegramMessage += `   ✅ 성공: ${stats.successCount}명\n`;
        telegramMessage += `   ❌ 실패: ${stats.failCount}명\n`;
      }
    }

    try {
      await sendTelegramMessage(telegramMessage);
    } catch (telegramError) {
      console.error("Error sending telegram message:", telegramError);
    }

    // 함수 호출 완료 추적
    await completeFunctionCall(callId, result, {
      ...metadata,
      period,
      totalMiningAmount,
      totalRewardAmount,
      totalUsersRewarded,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Special bonus distributed successfully",
        callId: callId,
        period: period,
        totalMiningAmount: totalMiningAmount,
        totalRewardAmount: totalRewardAmount,
        totalUsersRewarded: totalUsersRewarded,
        levelStats: levelStats,
      }),
      {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    console.error(
      "Error processing special bonus:",
      error instanceof Error ? error.message : error,
    );

    // 함수 호출 실패 추적
    await failFunctionCall(
      callId,
      error instanceof Error ? error.message : "Unknown error",
      metadata,
    );

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        callId: callId,
      }),
      {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
