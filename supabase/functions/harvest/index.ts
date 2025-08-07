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
  const username = profile.username || "";
  console.log(`[${username}] 🚀 Harvest started - IP: ${ip}`);

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
    console.log(`[${username}] 🚫 Blocked user`);

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
      console.error(`[${username}] User ID mismatch`);

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
            console.log(`[${username}] ❕ Duplicate harvest request detected`);

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
                error: "Too Many Requests",
              }),
              { status: 429, headers },
            );
          }

          // 다른 에러인 경우
          console.error(
            `[${username}] Error creating harvest record:`,
            harvestError,
          );
          return new Response(
            JSON.stringify({ error: "Failed to process harvest request" }),
            { status: 500, headers },
          );
        }
      }
    } catch (dbError) {
      console.error(`[${username}] Database error:`, dbError);
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
      console.error(
        `[${username}] Error fetching my packages:`,
        myPackagesError,
      );
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
      console.error(
        `[${username}] Invalid harvest time`,
        lastHarvestTime,
        minDate,
      );
      return new Response(
        JSON.stringify({ error: "Invalid harvest time" }),
        { status: 400, headers },
      );
    }

    const timeDiff = currentTime.getTime() - lastHarvestTime.getTime();
    const secondsDiff = Math.floor(timeDiff / 1000);

    if (secondsDiff < settings.mining_cooltime) {
      console.error(`[${username}] Mining cooltime error`);
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

    const feeAmount = parseFloat(settings.harvest_fee || 0);

    // 채굴 계산 준비
    const packagesWithMining = [];
    let totalCalculatedMining = 0; // 전체 계산된 채굴량
    let totalRegularMined = 0; // 시간 기반 채굴량
    let totalBonusUsed = 0; // 사용된 매칭보너스
    let remainingMatchingBonus = remainMatchingBonus;

    // 현재 시간
    const harvestTime = lastHarvestTime.getTime();

    // 1단계: 각 노드의 채굴 가능량을 병렬로 계산 (클라이언트와 동일)
    const nodesPotentialMining = [];
    let totalPotentialMining = 0;

    for (const pkg of myPackages) {
      const packageMiningPower = parseFloat(pkg.mining_power || 0);
      const currentMined = parseFloat(pkg.total_mined || 0);
      const maxOut = parseFloat(pkg.max_out || 0);

      // 노드의 채굴 시간 계산
      const nodeCreatedTime = new Date(pkg.created_at).getTime();
      let effectiveElapsedSeconds = 0;

      if (nodeCreatedTime > harvestTime) {
        // 마지막 수확 이후에 구매한 노드: 구매일로부터의 시간
        effectiveElapsedSeconds = Math.max(
          0,
          (currentTime.getTime() - nodeCreatedTime) / 1000,
        );
        // console.log(
        //   `Package ${pkg.name}: new node, mining from purchase date, elapsed=${effectiveElapsedSeconds}s`,
        // );
      } else {
        // 마지막 수확 이전에 구매한 노드: 마지막 수확 시간부터의 시간
        effectiveElapsedSeconds = secondsDiff;
      }

      // 시간 기반 채굴량 계산 (채굴파워 * 시간)
      const potentialMining = packageMiningPower * effectiveElapsedSeconds;
      const remainingCapacity = maxOut - currentMined;

      // 실제 채굴 가능량 (maxOut 제한 적용)
      const actualPotentialMining = Math.min(
        potentialMining,
        remainingCapacity,
      );

      nodesPotentialMining.push({
        ...pkg,
        packageMiningPower,
        currentMined,
        maxOut,
        effectiveElapsedSeconds,
        potentialMining,
        actualPotentialMining,
        remainingCapacity: remainingCapacity,
      });

      // 활성 노드만 총 채굴량에 포함 (maxOut까지만)
      if (currentMined < maxOut && packageMiningPower > 0) {
        totalPotentialMining += actualPotentialMining;
      }
    }

    // 2단계: 계산된 총 채굴량을 순차적으로 배분
    let remainingMiningAmount = totalPotentialMining;

    for (const nodePotential of nodesPotentialMining) {
      if (remainingMiningAmount <= 0) {
        break;
      }

      const currentMined = nodePotential.currentMined;
      const maxOut = nodePotential.maxOut;
      const packageMiningPower = nodePotential.packageMiningPower;

      // 이미 max_out에 도달하거나 mining_power가 0인 패키지는 건너뛰기
      if (currentMined >= maxOut || packageMiningPower <= 0) {
        continue;
      }

      // 이 노드에 할당할 수 있는 최대 채굴량
      const remainingCapacity = nodePotential.remainingCapacity;

      // 실제 할당할 채굴량 (남은 전체 채굴량과 노드 용량 중 작은 값)
      const allocatedMining = Math.min(
        remainingMiningAmount,
        remainingCapacity,
      );

      if (allocatedMining > 0) {
        // 채굴량 할당
        const updatedPkg = {
          ...nodePotential,
          newTotalMined: currentMined + allocatedMining,
          bonusMined: 0,
          regularMined: allocatedMining,
          miningAmount: allocatedMining,
          timeUsed: nodePotential.effectiveElapsedSeconds,
          remainingCapacity: remainingCapacity - allocatedMining,
        };

        packagesWithMining.push(updatedPkg);
        totalCalculatedMining += allocatedMining;
        totalRegularMined += allocatedMining;
        totalMined += allocatedMining;
        remainingMiningAmount -= allocatedMining;

        // console.log(
        //   `Package ${nodePotential.name}: allocated=${allocatedMining}, remaining pool=${remainingMiningAmount}`,
        // );
      }
    }

    // 3단계: 매칭보너스를 순차적으로 적용 (모든 노드에 구매순서대로)
    for (const nodePotential of nodesPotentialMining) {
      if (remainingMatchingBonus <= 0) {
        break; // 매칭보너스가 모두 소진되면 중단
      }

      // 이미 채굴량이 할당된 패키지 찾기
      const minedPkg = packagesWithMining.find((p) =>
        p.id === nodePotential.id
      );

      // 현재 노드의 남은 용량 계산
      let currentRemainingCapacity = 0;
      if (minedPkg) {
        currentRemainingCapacity = minedPkg.remainingCapacity;
      } else {
        // 채굴량이 할당되지 않은 노드의 경우 원래 남은 용량 사용
        const currentMined = nodePotential.currentMined;
        const maxOut = nodePotential.maxOut;
        currentRemainingCapacity = maxOut - currentMined;
      }

      // 남은 용량이 있는 노드에만 보너스 적용
      if (currentRemainingCapacity > 0) {
        const bonusMined = Math.min(
          remainingMatchingBonus,
          currentRemainingCapacity,
        );

        if (bonusMined > 0) {
          if (minedPkg) {
            // 이미 채굴량이 할당된 노드: 기존 데이터 업데이트
            minedPkg.newTotalMined += bonusMined;
            minedPkg.bonusMined = bonusMined;
            minedPkg.miningAmount += bonusMined;
            minedPkg.remainingCapacity -= bonusMined;
          } else {
            // 채굴량이 할당되지 않은 노드: 새로 추가
            const newPkg = {
              ...nodePotential,
              newTotalMined: nodePotential.currentMined + bonusMined,
              bonusMined: bonusMined,
              regularMined: 0,
              miningAmount: bonusMined,
              timeUsed: nodePotential.effectiveElapsedSeconds,
              remainingCapacity: currentRemainingCapacity - bonusMined,
            };
            packagesWithMining.push(newPkg);
          }

          remainingMatchingBonus -= bonusMined;
          totalBonusUsed += bonusMined;
          totalCalculatedMining += bonusMined;
          totalMined += bonusMined;

          // console.log(
          //   `Package ${nodePotential.name}: bonus applied=${bonusMined}, remaining bonus=${remainingMatchingBonus}`,
          // );
        }
      }
    }

    if (totalCalculatedMining <= 0) {
      console.error(`[${username}] No mining amount calculated`);
      return new Response(
        JSON.stringify({ error: "No mining amount calculated" }),
        { status: 200, headers },
      );
    }

    // * 정책 : 남은 매칭보너스는 지금하지 않고 버림.
    // console.log("remainingMatchingBonus:" + remainingMatchingBonus);
    // console.log("totalMined:" + totalMined);
    // console.log("totalBonusUsed:" + totalBonusUsed);
    // console.log("totalRegularMined:" + totalRegularMined);

    ////////////////////////////////////////////////////////////////
    // 토큰 전송 처리
    ////////////////////////////////////////////////////////////////

    // 수수료가 총 채굴량보다 큰 경우 체크
    if (totalMined < feeAmount) {
      console.error(`[${username}] Total mined amount is less than fee amount`);
      return new Response(
        JSON.stringify({
          error: "Insufficient mining amount",
          totalMined: totalMined,
          feeAmount: feeAmount,
        }),
        { status: 400, headers },
      );
    }

    // 총 전송할 토큰(Matching Bonus 제외) 계산
    const transferAmount = totalMined - feeAmount;

    // 토큰 전송
    const toAddress = wallet.address;

    setOperationWallet(settings.wallet_operation); // 수수료를 지불할 지갑 설정

    let result;
    let feeTxHash = "";

    try {
      // 수수료 전송 먼저 (작은 금액부터 안전하게)
      if (feeAmount > 0) {
        console.log(`[${username}] Sending harvest fee: ${feeAmount} MGG`);
        const feeResult = await sendMgg(
          settings.wallet_reward,
          settings.wallet_fee,
          feeAmount.toString(),
        );

        if (!feeResult || feeResult.error) {
          console.error(
            `[${username}] Error sending fee:`,
            feeResult?.error || "No fee result",
          );

          // 수수료 전송 실패 시 전체 실패 처리
          try {
            await supabase
              .from("harvests")
              .update({
                status: "FAILED",
                data: {
                  error_message: feeResult?.error || "Fee transfer failed",
                  error_type: "FEE_TRANSFER_FAILED",
                  error_time: new Date().toISOString(),
                },
                processed_at: new Date().toISOString(),
              })
              .eq("user_id", user.id)
              .eq("status", "HARVESTING")
              .order("created_at", { ascending: false })
              .limit(1);
          } catch (dbError) {
            console.error(
              `[${username}] Error updating failed harvest record:`,
              dbError,
            );
          }

          return new Response(
            JSON.stringify({
              error: feeResult?.error || "Fee transfer failed",
            }),
            { status: 500, headers },
          );
        }

        feeTxHash = feeResult.txHash || "";
        // 수수료 전송 성공 로그 제거 - 불필요

        // 트랜잭션 간 지연 추가 (최소 1초)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // 메인 토큰 전송
      console.log(`[${username}] Sending harvest reward: ${transferAmount} MGG to ${toAddress}`);
      result = await sendMgg(
        settings.wallet_reward,
        toAddress,
        transferAmount.toString(),
      );

      if (!result || result.error) {
        console.error(
          `[${username}] Error sending main token:`,
          result?.error || "No result",
        );

        // 메인 토큰 전송 실패 - 수수료는 이미 전송됨
        // 수수료 회수 시도
        if (feeAmount > 0 && feeTxHash) {
          console.log(
            `[${username}] Main transfer failed, attempting to recover fee`,
          );
          try {
            const feeRecoverResult = await sendMgg(
              settings.wallet_fee,
              settings.wallet_reward,
              feeAmount.toString(),
            );

            if (!feeRecoverResult || feeRecoverResult.error) {
              console.error(
                `[${username}] Failed to recover fee:`,
                feeRecoverResult?.error,
              );

              // harvest 실패 기록 업데이트 (수수료 회수 실패)
              try {
                await supabase
                  .from("harvests")
                  .update({
                    status: "FAILED",
                    data: {
                      error_message:
                        "Main transfer failed, fee recovery failed",
                      error_type: "MAIN_TRANSFER_FAILED_FEE_RECOVERY_FAILED",
                      main_error: result?.error || "Main transfer failed",
                      fee_tx_hash: feeTxHash,
                      fee_recovery_error: feeRecoverResult?.error ||
                        "No recovery result",
                      error_time: new Date().toISOString(),
                    },
                    processed_at: new Date().toISOString(),
                  })
                  .eq("user_id", user.id)
                  .eq("status", "HARVESTING")
                  .order("created_at", { ascending: false })
                  .limit(1);
              } catch (dbError) {
                console.error(
                  `[${username}] Error updating failed harvest record:`,
                  dbError,
                );
              }

              return new Response(
                JSON.stringify({
                  error: "Critical system error: Please contact administrator",
                }),
                { status: 500, headers },
              );
            }

            console.log(
              `[${username}] Fee recovery successful:`,
              feeRecoverResult.txHash,
            );

            // harvest 실패 기록 업데이트 (수수료 회수 성공)
            try {
              await supabase
                .from("harvests")
                .update({
                  status: "FAILED",
                  data: {
                    error_message: "Main transfer failed, fee recovered",
                    error_type: "MAIN_TRANSFER_FAILED_FEE_RECOVERED",
                    main_error: result?.error || "Main transfer failed",
                    fee_tx_hash: feeTxHash,
                    fee_recovery_tx_hash: feeRecoverResult.txHash,
                    error_time: new Date().toISOString(),
                  },
                  processed_at: new Date().toISOString(),
                })
                .eq("user_id", user.id)
                .eq("status", "HARVESTING")
                .order("created_at", { ascending: false })
                .limit(1);
            } catch (dbError) {
              console.error(
                `[${username}] Error updating failed harvest record:`,
                dbError,
              );
            }

            return new Response(
              JSON.stringify({
                error: "Main transfer failed. Fee has been recovered.",
              }),
              { status: 500, headers },
            );
          } catch (recoverError) {
            console.error(
              `[${username}] Exception during fee recovery:`,
              recoverError,
            );

            // harvest 실패 기록 업데이트 (수수료 회수 예외)
            try {
              await supabase
                .from("harvests")
                .update({
                  status: "FAILED",
                  data: {
                    error_message:
                      "Main transfer failed, fee recovery exception",
                    error_type: "MAIN_TRANSFER_FAILED_FEE_RECOVERY_EXCEPTION",
                    main_error: result?.error || "Main transfer failed",
                    fee_tx_hash: feeTxHash,
                    recovery_exception: recoverError instanceof Error
                      ? recoverError.message
                      : "Unknown recovery error",
                    error_time: new Date().toISOString(),
                  },
                  processed_at: new Date().toISOString(),
                })
                .eq("user_id", user.id)
                .eq("status", "HARVESTING")
                .order("created_at", { ascending: false })
                .limit(1);
            } catch (dbError) {
              console.error(
                `[${username}] Error updating failed harvest record:`,
                dbError,
              );
            }

            return new Response(
              JSON.stringify({
                error: "Critical system error: Please contact administrator",
              }),
              { status: 500, headers },
            );
          }
        } else {
          // 수수료가 없었던 경우 단순 실패 처리
          try {
            await supabase
              .from("harvests")
              .update({
                status: "FAILED",
                data: {
                  error_message: result?.error || "Main transfer failed",
                  error_type: "MAIN_TRANSFER_FAILED",
                  error_time: new Date().toISOString(),
                },
                processed_at: new Date().toISOString(),
              })
              .eq("user_id", user.id)
              .eq("status", "HARVESTING")
              .order("created_at", { ascending: false })
              .limit(1);
          } catch (dbError) {
            console.error(
              `[${username}] Error updating failed harvest record:`,
              dbError,
            );
          }

          return new Response(
            JSON.stringify({ error: result?.error || "Main transfer failed" }),
            { status: 500, headers },
          );
        }
      }

      // 토큰 전송 성공

      // 토큰 전송이 성공했으므로 이제 패키지 업데이트 진행
      // 원본 myPackages에 miningAmount 추가 (마이닝 기록 생성용)
      for (const pkg of packagesWithMining) {
        const { data, error } = await supabase
          .from("mypackages")
          .update({
            total_mined: pkg.newTotalMined,
          })
          .eq("id", pkg.id);

        if (error) {
          console.error(`[${username}] Error updating package:`, error);
          // 패키지 업데이트 실패는 로그만 남기고 계속 진행
        }

        // packagesWithMining에 이미 miningAmount가 있으므로 별도 추가 불필요
      }
    } catch (error) {
      console.error(`[${username}] Token transfer error:`, error);

      const errorMessage = error instanceof Error
        ? error.message
        : "Token transfer exception";
      const errorStack = error instanceof Error ? error.stack : undefined;

      // harvest 실패 기록 업데이트
      try {
        await supabase
          .from("harvests")
          .update({
            status: "FAILED",
            data: {
              error_message: errorMessage,
              error_type: "TOKEN_TRANSFER_EXCEPTION",
              error_stack: errorStack,
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
        JSON.stringify({ error: "Token transfer failed" }),
        { status: 500, headers },
      );
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
      console.error(
        `[${username}] Update profile error:`,
        updateProfileError.message,
      );
    }

    ////////////////////////////////////////////////////////////////
    // profit 변수 정의
    const profit = transferAmount;

    // 패키지별 마이닝 기록 생성 (토큰 전송 후)
    for (let i = 0; i < packagesWithMining.length; i++) {
      const pkg = packagesWithMining[i];
      if (!pkg?.miningAmount || pkg.miningAmount <= 0) {
        continue;
      }

      // 원본 패키지 정보 찾기
      const originalPkg = myPackages.find((p: any) => p.id === pkg.id);

      // 패키지별 마이닝 기록 생성
      const { data: miningTx, error: miningTxError } = await supabase
        .from("mining")
        .insert({
          user_id: user.id,
          package_id: pkg.id,
          name: originalPkg?.name || pkg.name,
          amount: pkg.miningAmount,
          user_level: profile.user_level,
          tx_hash: result.txHash,
          fee_amount: i === 0 ? feeAmount : 0,
          fee_tx_hash: i === 0 ? feeTxHash : "",
        });

      if (miningTxError) {
        console.error(
          `[${username}] Mining transaction error:`,
          miningTxError.message,
        );
      }
    }

    // Matching Bonus 마이닝 Tx 기록
    const usedMatchingBonus = totalBonusUsed; // 실제 적용된 매칭보너스 사용
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
          `[${username}] Matching bonus transaction error:`,
          miningTxError.message,
        );
      }

      // 사용된 매칭 보너스는 이미 totalMined에 포함되어 있음
    }

    // console.log("transferred_amount:" + profit);
    // console.log("mining_total_amount:" + totalMined);

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
          `[${username}] Update matching bonus error:`,
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
    let matchingBonusRate: number[] = [];
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

    // 업라인 매칭보너스 처리 시작

    while (uplineCode && levelCount < 6) {
      // 상위 후원자 조회
      const { data: uplineUser, error: uplineError } = await supabase
        .from("profiles")
        .select("*")
        .eq("my_referral_code", uplineCode)
        .single();

      if (uplineError) {
        console.error(`[${username}] Error fetching upline:`, uplineError);
        break;
      }

      // 수정된 조건: levelCount보다 uplineUser.user_level이 높거나 같은 경우에만 보너스 지급
      if (uplineUser.user_level <= levelCount) {
        uplineCode = uplineUser.upline_code;
        continue;
      }

      // A. 업라인의 매칭 등급이 하위 업라인의 매칭 등급보다 높아야 함
      if (levelCount > 0 && uplineUser.user_level <= profile.user_level) {
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
          `[${username}] upline bonus to ${uplineUser.username}: ${currentLevelBonusRate}% = ${bonus.toLocaleString()} (level: ${
            levelCount + 1
          })`,
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
          console.error(
            `[${username}] Error incrementing matching bonus:`,
            error,
          );
        } else {
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
              `[${username}] Error recording matching bonus history:`,
              bonusTxError,
            );
          }
        }
      } else {
      }

      // 35% 제한에 도달하면 중단
      if (totalAppliedRate >= 35) {
        break;
      }

      // 다음 상위 후원자를 찾기 위해 후원자 코드 업데이트
      uplineCode = uplineUser.upline_code;
      levelCount++;
    }

    // console.log(
    //   `Matching bonus processing completed. Total applied rate: ${totalAppliedRate}%`,
    // );

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
      // 실제 사용된 채굴력 계산 (각 노드별 채굴력의 합)
      const actualTotalMiningPower = packagesWithMining.reduce(
        (sum, pkg) => sum + pkg.packageMiningPower,
        0,
      );

      const harvestData = {
        mining_power: actualTotalMiningPower,
        calculated_mining: totalCalculatedMining,
        seconds_diff: secondsDiff,
        elapsed_seconds: elapsedSeconds,
        total_mined: totalMined,
        packages_info: packagesWithMining.map((pkg) => ({
          id: pkg.id,
          name: pkg.name,
          mining_amount: pkg.miningAmount || 0,
          bonus_mined: pkg.bonusMined || 0,
          regular_mined: pkg.regularMined || 0,
          total_mined: pkg.newTotalMined,
          max_out: pkg.max_out,
          time_used: pkg.timeUsed || 0,
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
        console.error(
          `[${username}] Error updating harvest record:`,
          updateError,
        );
      }
    } catch (dbError) {
      console.error(
        `[${username}] Database error while updating harvest:`,
        dbError,
      );
    }

    // 성공 응답
    console.log(`[${username}] ✅ Harvest completed - Amount: ${profit} MGG`);
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
    console.error(
      `[${profile?.username || "unknown"}] 🛑 Unexpected error:`,
      error,
    );

    const errorMessage = error instanceof Error
      ? error.message
      : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;

    // 에러 발생 시 harvest 레코드 업데이트
    try {
      await supabase
        .from("harvests")
        .update({
          status: "FAILED",
          data: {
            error_message: errorMessage,
            error_stack: errorStack,
            error_time: new Date().toISOString(),
          },
          processed_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("status", "HARVESTING")
        .order("created_at", { ascending: false })
        .limit(1);
    } catch (dbError) {
      console.error(
        `[${
          profile?.username || "unknown"
        }] Error updating failed harvest record:`,
        dbError,
      );
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
