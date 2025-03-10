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

    //
    const { user, profile, wallet, settings } = authResult;
    console.log("user_id:" + JSON.stringify(user.id));

    // 요청 데이터 파싱 : 없음
    const { user_id, elapsedSeconds } = await req.json();

    // 현재 시간 가져오기
    const currentTime = new Date();

    // harvest 시간 계산 : 현재시간 - profile.last_harvest_time을 초로 환상
    const lastHarvestTime = new Date(profile.last_harvest);
    const timeDiff = currentTime.getTime() - lastHarvestTime.getTime();
    const secondsDiff = Math.floor(timeDiff / 1000);

    console.log(
      "Server Seconds: " + secondsDiff,
      "Client Seconds: " + elapsedSeconds,
    );

    if (secondsDiff < settings.mining_cooltime) {
      return new Response(
        JSON.stringify({ error: "Mining cooltime" }),
        { status: 400, headers },
      );
    }

    // 사용자의 my_packages 조회 : status = "active"
    const { data: myPackages, error: myPackagesError } = await supabase
      .from("mypackages")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true });

    if (myPackagesError) {
      console.error("Error fetching my packages:", myPackagesError);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    // Haverst (mining) package별 채굴량 가감/트랜잭션 기록 생성
    let totalMined = 0;
    let remainMatchingBonus = profile.matching_bonus;

    // 토큰 전송 전에 채굴량 계산
    const miningPromises = myPackages.map(async (pkg) => {
      // 채굴량
      let miningAmount = pkg.mining_power * secondsDiff;

      // 남은 최대 채굴량 계산
      let remainMaxOut = pkg.max_out - pkg.total_mined;

      // 매칭보너스가 남아있으면
      if (remainMatchingBonus > 0) {
        // 남은 최대 채굴량이 매칭보너스보다 크면
        if (remainMaxOut >= remainMatchingBonus) {
          // 남은 매칭 보너스 만큼 채굴량 증가
          miningAmount += remainMatchingBonus;
          // 남은 매칭 보너스 0으로 초기화
          remainMatchingBonus = 0;
        } else {
          // 남은 최대 채굴량 만큼 채굴량 증가
          miningAmount += remainMaxOut;
          // 남은 매칭 보너스 감소
          remainMatchingBonus -= remainMaxOut;
        }
      }

      // 채굴량 업데이트
      const { data: updatePackage, error: updatePackageError } = await supabase
        .from("mypackages")
        .update({
          total_mined: `total_mined + ${miningAmount}`,
        })
        .eq("id", pkg.id);

      if (updatePackageError) {
        console.error("Update package error:", updatePackageError.message);
      }

      totalMined += miningAmount;

      return { miningAmount, packageId: pkg.id, name: pkg.name };
    });

    // Promise.all로 모든 비동기 작업 완료 대기
    const miningResults = await Promise.all(miningPromises);

    // 총 전송할 토큰 계산
    const totalTransferAmount = miningResults.reduce((acc, curr) => {
      return acc + curr.miningAmount;
    }, 0);

    // * 정책 : 남은 매칭보너스는 지금하지 않고 버림.

    // 사용된 매칭 보너스 계산
    const usedMatchingBonus = profile.matching_bonus - remainMatchingBonus;

    // 토큰 전송
    const fromAddress = settings.wallet_reward;
    const toAddress = wallet.address;

    setOperationWallet(fromAddress); // 수수료를 지불할 지갑 설정
    const result = await sendMgg(
      fromAddress,
      toAddress,
      totalTransferAmount.toString(),
    );

    if (result.error) {
      console.error("Error sending MGG:", result.error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    // profit 변수 정의
    const profit = totalTransferAmount;

    // 트랜잭션 기록 생성 (토큰 전송 후)
    const txInsertPromises = miningResults.map(async (item) => {
      const { data: miningTx, error: miningTxError } = await supabase
        .from("mining")
        .insert({
          user_id: user.id,
          package_id: item.packageId,
          name: item.name,
          amount: item.miningAmount,
          user_level: profile.user_level,
          tx_hash: result.txHash,
        });

      if (miningTxError) {
        console.error("Mining transaction error:", miningTxError.message);
      }

      return miningTx;
    });

    await Promise.all(txInsertPromises);

    // Matching Bonus 지급 Tx 기록
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

    // 프로필에 마지막 채굴 시간 업데이트
    const { data: updateProfile, error: updateProfileError } = await supabase
      .from("profiles")
      .update({
        last_harvest: currentTime,
      })
      .eq("user_id", user.id);

    if (updateProfileError) {
      console.error("Update profile error:", updateProfileError.message);
    }

    ////////////////////////////////////////////////////////////////
    // Upline에게 Matching Bonus 지급 처리
    // 총 35% = 1L:10% 2L:5% 3L:5% 4L:5% 5L:5% 6L:5%
    // 1~6레벨까지 지급
    const matchingBonusRate = [10, 5, 5, 5, 5, 5];
    let totalMatchingBonusRate = 0;
    let levelCount = 0;
    let uplineCode = profile.upline_code;

    while (uplineCode) {
      // 상위 후원자 조회
      const { data: uplineData, error: uplineError } = await supabase
        .from("profiles")
        .select("*")
        .eq("my_referral_code", uplineCode)
        .single();

      if (uplineError) {
        break;
      }

      for (let i = levelCount; i < uplineData.user_level; i++) {
        totalMatchingBonusRate += matchingBonusRate[i];
      }

      // matching bonus 지급
      const bonus = (profit * totalMatchingBonusRate) / 100;
      const { data, error } = await supabase.rpc("increment_matching_bonus", {
        userid: uplineData.user_id,
        mining_total: totalMined,
        transfer_amount: profit,
        amount: bonus,
      });

      if (error) {
        console.error("Error incrementing matching bonus:", error);
      }

      // 위에서 채굴에 mining에 tx를 넣어서 여기서는 tx를 기록하지 않음.

      // 다음 상위 후원자를 찾기 위해 후원자 코드 업데이트
      uplineCode = uplineData.upline_code;
      levelCount++;
      if (levelCount >= 6) {
        break;
      }
    }

    // 성공 응답
    return new Response(
      JSON.stringify({
        success: true,
        message: "Harvest successful",
        harvest_amount: profit,
        harvest_time: currentTime,
      }),
      { status: 200, headers },
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers },
    );
  }
});
