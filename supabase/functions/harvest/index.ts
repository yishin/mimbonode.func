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
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";

// Edge Function 시작
serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

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
    `🚀 user_id: ${profile.username} (${user.id}) ${ip}`,
  );

  // 시작 로그 기록
  try {
    await supabase.from("debug_logs").insert({
      function_name: "harvest",
      message: "Function started",
      data: { user_id: user.id, username: profile.username },
    });
  } catch (logError) {
    console.error("Error logging start:", logError);
  }

  ////////////////////////////////
  // Block 체크
  if (profile?.is_block) {
    console.log("🚫 Blocked user");

    try {
      await supabase.from("debug_logs").insert({
        function_name: "harvest",
        message: "Blocked user",
        data: { user_id: user.id, username: profile.username },
      });
    } catch (logError) {
      console.error("Error logging:", logError);
    }

    return new Response(
      JSON.stringify({
        error: "Wrong request",
      }),
      { status: 500, headers },
    );
  }

  // 채굴 시작 시 락 획득 시도
  // const { data: lockAcquired, error: lockError } = await supabase
  //   .rpc("acquire_harvesting_lock", { user_id_param: user.id });

  // if (lockError) {
  //   console.error("Error acquiring harvesting lock:", lockError);
  //   return new Response(
  //     JSON.stringify({ error: "Internal server error" }),
  //     { status: 500, headers },
  //   );
  // }

  // if (!lockAcquired) {
  //   console.log("Harvesting already in progress");
  //   return new Response(
  //     JSON.stringify({ error: "Harvesting already in progress" }),
  //     { status: 429, headers },
  //   );
  // }

  try {
    // 요청 데이터 파싱 : 없음
    const { user_id, elapsedSeconds } = await req.json();
    const matchingBonus = profile.matching_bonus;

    // 요청 사용자 검증
    if (user.id !== user_id) {
      console.error("User ID mismatch");
      return new Response(
        JSON.stringify({ error: "User ID mismatch" }),
        { status: 401, headers },
      );
    }

    // 중복 방지를 위해 harvests 테이블에 요청 기록 생성
    try {
      // 먼저 1시간 이내 FAILED 상태의 이전 요청이 있는지 확인
      const { data: existingError, error: errorCheckError } = await supabase
        .from("harvests")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "FAILED")
        .eq("request_group", Math.floor(Date.now() / 1000 / 3600))
        .order("created_at", { ascending: false })
        .limit(1);

      if (existingError && existingError.length > 0) {
        // 이전 ERROR 레코드 업데이트
        await supabase
          .from("harvests")
          .update({
            status: "HARVESTING",
            elapsed_seconds: elapsedSeconds,
            data: {
              ...existingError[0].data,
              retry_time: new Date().toISOString(),
              retry_count: ((existingError[0].data || {}).retry_count || 0) + 1,
            },
          })
          .eq("id", existingError[0].id);

        console.log(
          "Updated existing error record for retry:",
          existingError[0].id,
        );
      } else {
        // 1시간 이내 이전 요청이 없으면 새로운 요청 생성
        const { data: harvestRequest, error: harvestError } = await supabase
          .from("harvests")
          .insert({
            user_id: user.id,
            username: profile.username,
            elapsed_seconds: elapsedSeconds,
            status: "HARVESTING",
            data: {
              device_info: req.headers.get("user-agent"),
              client_time: new Date().toISOString(),
            },
          })
          .select()
          .single();

        if (harvestError) {
          // 유니크 제약 위반 (23505)인 경우 = 1시간 이내 중복 요청
          if (harvestError.code === "23505") {
            console.log("❕ Duplicate harvest request detected");

            try {
              await supabase.from("debug_logs").insert({
                function_name: "harvest",
                message: "Duplicate harvest request detected",
                data: { user_id: user.id, username: profile.username },
              });
            } catch (logError) {
              console.error("Error logging:", logError);
            }

            return new Response(
              JSON.stringify({
                error: "Rate limit exceeded.",
              }),
              { status: 429, headers },
            );
          }

          // 다른 에러인 경우
          console.error("Error creating harvest record:", harvestError);
          return new Response(
            JSON.stringify({ error: "Failed to process harvest request" }),
            { status: 500, headers },
          );
        }
        console.log("Harvest request created:", harvestRequest.id);
      }
    } catch (dbError) {
      console.error("Database error:", dbError);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    // 사용자의 my_packages 조회 : status = "active"
    const { data: myPackages, error: myPackagesError } = await supabase
      .from("mypackages")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("sid", { ascending: true });

    if (myPackagesError || !myPackages || myPackages.length === 0) {
      console.error("Error fetching my packages:", myPackagesError);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    ////////////////////////////////
    // 현재 시간 가져오기
    const currentTime = new Date();

    // harvest 시간 계산 : 현재시간 - profile.last_harvest_time을 초로 환상
    const lastHarvestTime = new Date(
      profile?.last_harvest ? profile.last_harvest : myPackages[0].created_at,
    );

    // 2025년 3월 18일 이전이면 에러 처리
    const minDate = new Date("2025-03-18");
    if (lastHarvestTime < minDate) {
      console.error("Invalid harvest time");
      return new Response(
        JSON.stringify({ error: "Invalid harvest time" }),
        { status: 400, headers },
      );
    }

    const timeDiff = currentTime.getTime() - lastHarvestTime.getTime();
    const secondsDiff = Math.floor(timeDiff / 1000);

    console.log(
      "Server Seconds: " + secondsDiff,
      "Client Seconds: " + elapsedSeconds,
    );

    if (secondsDiff < settings.mining_cooltime) {
      console.error("Mining cooltime error");
      return new Response(
        JSON.stringify({ error: "Mining cooltime error" }),
        { status: 200, headers },
      );
    }

    ////////////////////////////////////////////////////////////////
    // 채굴 처리
    ////////////////////////////////////////////////////////////////

    // Haverst (mining) package별 채굴량 가감/트랜잭션 기록 생성
    let totalMined = 0; // 총 채굴량
    let remainMatchingBonus = profile.matching_bonus; // 남은 매칭보너스

    const totalMiningPower = myPackages.reduce((sum, pkg) => {
      // 이미 채굴된 노드는 채굴력 더하지 않음
      if (pkg.total_mined < pkg.max_out) {
        return sum + parseFloat(pkg.mining_power);
      }

      return sum;
    }, 0); // 총 채굴력

    const feeAmount = parseFloat(settings.harvest_fee || 0);
    let toMiningAmount = totalMiningPower * secondsDiff + remainMatchingBonus; // 총 채굴할 량 = 총 채굴력 * 채굴 시간 + 남은 매칭보너스

    if (toMiningAmount <= 0) {
      console.error("Mining amount error");
      return new Response(
        JSON.stringify({ error: "Mining amount error" }),
        { status: 200, headers },
      );
    }

    // 1. 토큰 전송 전에 노드별 채굴 (우선 마이닝만)
    toMiningAmount = totalMiningPower * secondsDiff;
    for (const pkg of myPackages) {
      if (pkg.total_mined >= pkg.max_out) {
        continue;
      }

      // 패키지의 남은 최대 채굴량 계산
      let remainPkgMiningAmount = pkg.max_out - pkg.total_mined;

      // 패키지 남은 채굴량이 총 채굴할 량보다 작으면 => 패키지 남은 채굴량만큼 채굴하고 다음 패키지 채굴
      let miningAmount = Math.min(remainPkgMiningAmount, toMiningAmount);
      pkg.total_mined += miningAmount;
      if (pkg.total_mined === pkg.max_out) {
        // 패키지 완전 채굴 처리
        const { data, error } = await supabase
          .from("mypackages")
          .update({
            total_mined: pkg.total_mined,
            // status: "completed", // 사용자가 채굴 완료 처리
          })
          .eq("id", pkg.id);

        if (error) {
          console.error("Error updating package:", error);
        }

        // 총 채굴할 량에서 패키지 채굴량 차감
        pkg.miningAmount = miningAmount;
        toMiningAmount -= miningAmount;
        totalMined += miningAmount;
      } else {
        //
        const { data, error } = await supabase
          .from("mypackages")
          .update({
            total_mined: pkg.total_mined,
          })
          .eq("id", pkg.id);

        if (error) {
          console.error("Error updating package:", error);
        }

        // 총 채굴할 량에서 패키지 채굴량 차감
        pkg.miningAmount = miningAmount;
        toMiningAmount -= miningAmount;
        totalMined += miningAmount;
        break;
      }

      if (toMiningAmount <= 0) {
        break;
      }
    }

    // 2. 토큰 전송 전에 노드별 채굴 (매칭보너스만)
    toMiningAmount = remainMatchingBonus;
    for (const pkg of myPackages) {
      if (pkg.total_mined >= pkg.max_out) {
        continue;
      }

      // 패키지의 남은 최대 채굴량 계산
      let remainPkgMiningAmount = pkg.max_out - pkg.total_mined;

      // 패키지 남은 채굴량이 총 채굴할 량보다 작으면 => 패키지 남은 채굴량만큼 채굴하고 다음 패키지 채굴
      let miningAmount = Math.min(remainPkgMiningAmount, toMiningAmount);
      pkg.total_mined += miningAmount;
      if (pkg.total_mined === pkg.max_out) {
        // 패키지 완전 채굴 처리
        const { data, error } = await supabase
          .from("mypackages")
          .update({
            total_mined: pkg.total_mined,
            // status: "completed", // 사용자가 채굴 완료 처리
          })
          .eq("id", pkg.id);

        if (error) {
          console.error("Error updating package:", error);
        }

        // 총 채굴할 량에서 패키지 채굴량 차감
        toMiningAmount -= miningAmount;
        totalMined += miningAmount;
      } else {
        //
        const { data, error } = await supabase
          .from("mypackages")
          .update({
            total_mined: pkg.total_mined,
          })
          .eq("id", pkg.id);

        if (error) {
          console.error("Error updating package:", error);
        }

        // 총 채굴할 량에서 패키지 채굴량 차감
        // pkg.miningAmount = miningAmount; // 패키지별 마이닝 기록에 Matching Bonus 기록 안함
        toMiningAmount -= miningAmount;
        totalMined += miningAmount;
        break;
      }

      if (toMiningAmount <= 0) {
        break;
      }
    }

    // * 정책 : 남은 매칭보너스는 지금하지 않고 버림.
    console.log("remainMiningAmount:" + toMiningAmount);
    console.log("totalMined:" + totalMined);

    ////////////////////////////////////////////////////////////////
    // 토큰 전송 처리
    ////////////////////////////////////////////////////////////////

    // 총 전송할 토큰(Matching Bonus 제외) 계산
    const transferAmount = totalMined - feeAmount;

    // 토큰 전송
    const toAddress = wallet.address;

    setOperationWallet(settings.wallet_operation); // 수수료를 지불할 지갑 설정
    const result = await sendMgg(
      settings.wallet_reward,
      toAddress,
      transferAmount.toString(),
    ); // 마이닝한 만큼 MGG 토큰 전송

    if (result.error) {
      console.error("Error sending MGG:", result.error);
      return new Response(
        JSON.stringify({ error: result.error || "Internal server error" }),
        { status: 200, headers },
      );
    }

    // 트랜잭션 간 지연 추가 (최소 1초)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("waiting 1 sec");

    // 수수료 전송
    let feeTxHash = "";
    if (feeAmount > 0) {
      const feeResult = await sendMgg(
        settings.wallet_reward,
        settings.wallet_fee,
        feeAmount.toString(),
      );
      if (feeResult.error) {
        console.error("Error sending MGG 2:", result.error);
        return new Response(
          JSON.stringify({ error: result.error || "Internal server error" }),
          { status: 200, headers },
        );
      }

      feeTxHash = feeResult.txHash;
    }

    // 매칭 보너스 기록 로그
    try {
      await supabase.from("debug_logs").insert({
        function_name: "harvest",
        message: "mining",
        data: {
          user_id: user.id,
          username: profile.username,
          amount: transferAmount,
          fee_amount: feeAmount,
        },
      });
    } catch (logError) {
      console.error("Error logging start:", logError);
    }

    // 프로필에 마지막 채굴 시간 업데이트하여 중복 채굴 방지
    const { data: updateProfile, error: updateProfileError } = await supabase
      .from("profiles")
      .update({
        last_harvest: currentTime,
      })
      .eq("user_id", profile.user_id);

    if (updateProfileError) {
      console.error("Update profile error:", updateProfileError.message);
    }

    ////////////////////////////////////////////////////////////////
    // profit 변수 정의
    const profit = transferAmount;

    // 패키지별 마이닝 기록 생성 (토큰 전송 후)
    for (let i = 0; i < myPackages.length; i++) {
      const pkg = myPackages[i];
      if (!pkg?.miningAmount || pkg.miningAmount <= 0) {
        continue;
      }

      // 패키지별 마이닝 기록 생성
      const { data: miningTx, error: miningTxError } = await supabase
        .from("mining")
        .insert({
          user_id: user.id,
          package_id: pkg.id,
          name: pkg.name,
          amount: pkg.miningAmount,
          user_level: profile.user_level,
          tx_hash: result.txHash,
          fee_amount: i === 0 ? feeAmount : 0,
          fee_tx_hash: i === 0 ? feeTxHash : "",
        });

      if (miningTxError) {
        console.error("Mining transaction error:", miningTxError.message);
      }
    }

    // Matching Bonus 마이닝 Tx 기록
    const usedMatchingBonus = totalMined - (totalMiningPower * secondsDiff); // 사용된 매칭 보너스 = 총 마이닝량(마이닝량+매칭보너스) - (마이닝량)
    if (usedMatchingBonus > 0) {
      const { data: miningTx, error: miningTxError } = await supabase
        .from("mining")
        .insert({
          user_id: user.id,
          package_id: crypto.randomUUID(),
          name: "Matching Bonus",
          amount: usedMatchingBonus,
          user_level: profile.user_level,
          tx_hash: result.txHash,
          fee_amount: 0,
          fee_tx_hash: "",
        });

      if (miningTxError) {
        console.error(
          "Matching bonus transaction error:",
          miningTxError.message,
        );
      }

      // 사용된 매칭 보너스만 더함
      totalMined += usedMatchingBonus;
    }

    console.log("transferred_amount:" + profit);
    console.log("mining_total_amount:" + totalMined);

    // Harvest 시작시의 매칭 보너스 처리
    if (matchingBonus > 0) {
      // 매칭 보너스 차감
      const { data: updateMatchingBonus, error: updateMatchingBonusError } =
        await supabase
          .rpc("decrease_matching_bonus", {
            userid: profile.user_id,
            amount: matchingBonus,
          });

      if (updateMatchingBonusError) {
        console.error(
          "Update matching bonus error:",
          updateMatchingBonusError.message,
        );
      }
    }

    ////////////////////////////////////////////////////////////////
    // Upline에게 Matching Bonus 지급 처리
    // 총 35% = 1L:10% 2L:5% 3L:5% 4L:5% 5L:5% 6L:5%
    // 1~6레벨까지 지급
    // A. 업라인의 매칭 등급이 하위 업라인의 매칭 등급보다 높아야 한다.
    // B. 위 조건을 만족하면서 각 등급별로 다운라인에 가장 가까운 업라인에게 매칭 보너스를 지급한다.
    // 매칭 보너스율 계산: 다음 업라인의 보너스율은 이전에 나왔던 업라인의 보너스율을 차감한다.
    //                매칭 보너스를 받는 업라인끼리 적용되는 계산
    //                매칭 보너스율 = 상위 업라인의 매칭 보너스율 - 하위 업라인의 매칭 보너스율
    //                * 매칭 보너스율의 합은 35%를 넘지 않는다.
    // 매칭 보너스 계산: 업라인의 노드 채굴 수익  * 매칭 보너스율
    let matchingBonusRate = [];
    let appliedBonusRates = [0, 0, 0, 0, 0, 0]; // 각 레벨별로 이미 적용된 보너스율 추적
    let levelCount = profile.user_level;
    let uplineCode = profile.upline_code;
    let totalAppliedRate = 0; // 총 적용된 보너스율 (35% 제한용)

    if (profile.user_level == 0) {
      matchingBonusRate = [10, 5, 5, 5, 5, 5];
    } else if (profile.user_level == 1) {
      matchingBonusRate = [0, 15, 5, 5, 5, 5];
    } else if (profile.user_level == 2) {
      matchingBonusRate = [0, 0, 20, 5, 5, 5];
    } else if (profile.user_level == 3) {
      matchingBonusRate = [0, 0, 0, 25, 5, 5];
    } else if (profile.user_level == 4) {
      matchingBonusRate = [0, 0, 0, 0, 30, 5];
    } else if (profile.user_level == 5) {
      matchingBonusRate = [0, 0, 0, 0, 0, 35];
    }

    console.log("Starting upline matching bonus processing");

    while (uplineCode && levelCount < 6) {
      // 상위 후원자 조회
      const { data: uplineUser, error: uplineError } = await supabase
        .from("profiles")
        .select("*")
        .eq("my_referral_code", uplineCode)
        .single();

      if (uplineError) {
        console.error("Error fetching upline:", uplineError);
        break;
      }

      console.log(
        `Processing upline level ${
          levelCount + 1
        }, user: ${uplineUser.username}, level: ${uplineUser.user_level}`,
      );

      // 수정된 조건: levelCount보다 uplineUser.user_level이 높거나 같은 경우에만 보너스 지급
      if (uplineUser.user_level <= levelCount) {
        console.log(
          `Skipping upline ${uplineUser.username} - user level (${uplineUser.user_level}) not higher than current level count (${levelCount})`,
        );
        uplineCode = uplineUser.upline_code;
        continue;
      }

      // A. 업라인의 매칭 등급이 하위 업라인의 매칭 등급보다 높아야 함
      if (levelCount > 0 && uplineUser.user_level <= profile.user_level) {
        console.log(
          `Skipping upline ${uplineUser.username} - level not higher than downline`,
        );
        uplineCode = uplineUser.upline_code;
        levelCount++;
        continue;
      }

      // 이 업라인에게 적용할 보너스율 계산
      let currentLevelBonusRate = 0;

      // 각 레벨별 보너스율 계산
      for (let i = levelCount; i < Math.min(uplineUser.user_level, 6); i++) {
        // 이미 적용된 보너스율 차감
        const availableRate = matchingBonusRate[i] - appliedBonusRates[i];

        if (availableRate > 0) {
          // 총 35% 제한 확인
          const rateToApply = Math.min(availableRate, 35 - totalAppliedRate);
          currentLevelBonusRate += rateToApply;
          appliedBonusRates[i] += rateToApply;
          totalAppliedRate += rateToApply;

          // 35% 제한에 도달하면 중단
          if (totalAppliedRate >= 35) {
            break;
          }
        }
      }

      // 보너스율이 있는 경우에만 보너스 지급
      if (currentLevelBonusRate > 0) {
        // 매칭 보너스 계산
        const bonus = (profit * currentLevelBonusRate) / 100;

        console.log(
          `Applying bonus to ${uplineUser.username}: ${currentLevelBonusRate}% = ${bonus} (total applied: ${totalAppliedRate}%)`,
        );

        // 매칭 보너스 지급
        const { data, error } = await supabase.rpc(
          "increment_matching_bonus",
          {
            username: uplineUser.username,
            userid: uplineUser.user_id,
            mining_total: totalMined,
            transfer_amount: profit,
            amount: bonus,
            bonus_rate: currentLevelBonusRate,
          },
        );

        if (error) {
          console.error("Error incrementing matching bonus:", error);
        } else {
          console.log(
            `Successfully applied matching bonus to ${uplineUser.username}`,
          );

          // 매칭 보너스 지급 기록 생성
          const { data: bonusTx, error: bonusTxError } = await supabase
            .from("commissions")
            .insert({
              wallet: "MGG",
              user_id: uplineUser.user_id,
              type: "matching bonus",
              amount: bonus,
              total_amount: profit,
              message: `Matching bonus from ${profile.username} (level ${
                levelCount + 1
              })`,
            });

          if (bonusTxError) {
            console.error(
              "Error recording matching bonus history:",
              bonusTxError,
            );
          }
        }
      } else {
        console.log(
          `No bonus applied to ${uplineUser.username} - all rates already used or 35% limit reached`,
        );
      }

      // 35% 제한에 도달하면 중단
      if (totalAppliedRate >= 35) {
        console.log("Reached 35% total bonus rate limit, stopping");
        break;
      }

      // 다음 상위 후원자를 찾기 위해 후원자 코드 업데이트
      uplineCode = uplineUser.upline_code;
      levelCount++;
    }

    console.log(
      `Matching bonus processing completed. Total applied rate: ${totalAppliedRate}%`,
    );

    // 종료 로그 기록
    try {
      await supabase.from("debug_logs").insert({
        function_name: "harvest",
        message: "Function completed",
        data: { user_id: user.id, username: profile.username },
      });
    } catch (logError) {
      console.error("Error logging end:", logError);
    }

    // 성공적인 harvest 결과를 테이블에 업데이트
    try {
      const harvestData = {
        mining_power: totalMiningPower,
        seconds_diff: secondsDiff,
        elapsed_seconds: elapsedSeconds,
        total_mined: totalMined,
        packages_info: myPackages.map((pkg) => ({
          id: pkg.id,
          name: pkg.name,
          mining_amount: pkg.miningAmount || 0,
          total_mined: pkg.total_mined,
          max_out: pkg.max_out,
        })),
        matching_bonus_processed: {
          start_amount: matchingBonus,
          used_amount: usedMatchingBonus,
          remain_amount: matchingBonus - usedMatchingBonus,
        },
      };

      const { data: updatedHarvest, error: updateError } = await supabase
        .from("harvests")
        .update({
          harvest_amount: profit,
          fee_amount: feeAmount,
          matching_bonus_used: usedMatchingBonus,
          tx_hash: result.txHash,
          fee_tx_hash: feeTxHash,
          status: "COMPLETED",
          data: harvestData,
          processed_at: currentTime.toISOString(),
        })
        .eq("user_id", user.id)
        .eq("status", "HARVESTING")
        .order("created_at", { ascending: false })
        .limit(1);

      if (updateError) {
        console.error("Error updating harvest record:", updateError);
      }
    } catch (dbError) {
      console.error("Database error while updating harvest:", dbError);
    }

    // 성공 응답
    console.log(`✅ Harvest successful: ${profile.username} (${user.id})`);
    return new Response(
      JSON.stringify({
        success: true,
        message: "Harvest successful",
        harvest_amount: profit,
        harvest_time: currentTime,
        fee_amount: feeAmount,
      }),
      { status: 200, headers },
    );
  } catch (error) {
    console.error("🛑 Unexpected error:", error);

    // 에러 발생 시 harvest 레코드 업데이트
    try {
      await supabase
        .from("harvests")
        .update({
          status: "FAILED",
          data: {
            error_message: error.message || "Unknown error",
            error_stack: error.stack,
            error_time: new Date().toISOString(),
          },
          processed_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("status", "HARVESTING")
        .order("created_at", { ascending: false })
        .limit(1);
    } catch (dbError) {
      console.error("Error updating failed harvest record:", dbError);
    }

    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers },
    );
  } finally {
    // 락 해제
    // await supabase.rpc("release_harvesting_lock", { user_id_param: user.id });
  }
});
