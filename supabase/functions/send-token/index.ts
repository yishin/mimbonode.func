import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { supabase } from "../utils/supabaseClient.ts";
import { sendTokenTransaction } from "../utils/tokenUtils.ts";
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

        const user = authResult.user;
        console.log("user_id:" + JSON.stringify(user.id));

        // 요청 데이터 파싱
        const { toAddress, amount } = await req.json();

        if (!toAddress || !amount) {
            return new Response(
                JSON.stringify({ error: "Missing required fields" }),
                { status: 400, headers },
            );
        }

        // 환경설정 가져오기
        const { data: configData, error: configError } = await supabase
            .from("configs")
            .select("gas_fee_address")
            .eq("sid", 1)
            .single();

        // 가스비를 위한 주소 가져오기
        const { data: walletData, error: walletError } = await supabase
            .from("wallets")
            .select("address")
            .eq("sid", 1)
            .single();

        if (walletError || !walletData) {
            return new Response(
                JSON.stringify({ error: "Failed to retrieve gas fee address" }),
                { status: 500, headers },
            );
        }

        // 트랜잭션 기록 생성
        const { data: transactionData, error: insertError } = await supabase
            .from("transactions")
            .insert([
                {
                    user_id: user.id,
                    to_address: toAddress,
                    amount,
                    status: "pending",
                    tx_hash: null,
                    type: "token_transfer",
                },
            ])
            .select()
            .single();

        if (insertError) {
            console.error("Error creating transaction record:", insertError);
            return new Response(
                JSON.stringify({
                    error: "Failed to create transaction record",
                }),
                { status: 500, headers },
            );
        }

        try {
            // 토큰 전송 실행
            const tx = await sendTokenTransaction(toAddress, amount);

            // 트랜잭션 상태 업데이트
            await supabase
                .from("transactions")
                .update({
                    status: "completed",
                    tx_hash: tx.transactionHash,
                })
                .eq("id", transactionData.id);

            return new Response(
                JSON.stringify({
                    success: true,
                    transactionHash: tx.transactionHash,
                }),
                { status: 200, headers },
            );
        } catch (txError) {
            console.error("Token transfer failed:", txError);

            // 실패 상태로 업데이트
            await supabase
                .from("transactions")
                .update({ status: "failed" })
                .eq("id", transactionData.id);

            return new Response(
                JSON.stringify({ error: "Token transfer failed" }),
                { status: 500, headers },
            );
        }
    } catch (error) {
        console.error("Unexpected error:", error);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers },
        );
    }
});
