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
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";

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

    //
    const { user, profile, wallet, settings } = authResult;
    console.log(`user_id: ${profile.username} (${user.id})`);

    /**
     * 요청 데이터 파싱
     * amount : 구매한 금액 (USDT)
     */
    const { user_id, amount } = await req.json();

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

    // MiningPower 계산
    const miningPower = myPackages.reduce((acc, curr) => {
      return acc + curr.mining_power;
    }, 0);

    // 수익 계산 (MGG)
    const profit = miningPower * secondsDiff;

    // 토큰 전송
    const fromAddress = settings.wallet_reward;
    const toAddress = wallet.address;

    setOperationWallet(fromAddress); // 수수료를 지불할 지갑 설정
    const result = await sendMgg(
      fromAddress,
      toAddress,
      profit.toString(),
    );

    if (result.error) {
      console.error("Error sending MGG:", result.error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers },
      );
    }

    // Haverst (mining) package별 채굴량 가감/트랜잭션 기록 생성
    let totalMined = 0;
    myPackages.forEach(async (myPackage) => {
      // 트랜잭션 기록 생성
      const minedAmount = myPackage.mining_power * secondsDiff;
      totalMined += minedAmount;

      // 트랜잭션 기록 생성
      const { data: miningTx, error: miningTxError } = await supabase
        .from("mining")
        .insert({
          user_id: user.id,
          package_id: myPackage.id,
          name: myPackage.name,
          amount: minedAmount,
          user_level: profile.user_level,
          tx_hash: result.txHash,
        });

      if (miningTxError) {} // 추후 처리

      // 채굴량 가감
      const { data: updatePackage, error: updatePackageError } = await supabase
        .from("mypackages")
        .update({
          total_mined: myPackage.total_mined +
            myPackage.mining_power * secondsDiff,
        })
        .eq("id", myPackage.id);

      if (updatePackageError) {} // 추후 처리
    });

    console.log("transferred_amount:" + profit);
    console.log("mining_total_amount:" + totalMined);

    // 프로필 업데이트
    const { data: updateProfile, error: updateProfileError } = await supabase
      .from("profiles")
      .update({
        last_harvest: currentTime,
      })
      .eq("user_id", user.id);

    if (updateProfileError) {} // 추후 처리

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
