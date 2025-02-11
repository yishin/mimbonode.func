import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Web3 from "https://esm.sh/web3@1.6.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

// Web3 설정
const isProduction = Deno.env.get("ENVIRONMENT") === "production";
const CHAIN_ID = isProduction ? 137 : 80002;
const PSPN_TOKEN_ADDRESS = isProduction
  ? "0xYourProductionTokenAddress"
  : "0xC4Dc51274E4E1CFB6C5f51237Bf37f26Cf8a6695"; // Testnet Address
const operationsWalletPrivateKey = Deno.env.get(
  "OPERATIONS_WALLET_PRIVATE_KEY",
);

// Web3 인스턴스 생성
const provider = new Web3.providers.HttpProvider(
  isProduction
    ? `https://polygon-mainnet.g.alchemy.com/v2/${
      Deno.env.get("ALCHEMY_API_KEY")
    }`
    : `https://polygon-amoy.g.alchemy.com/v2/${
      Deno.env.get("ALCHEMY_API_KEY")
    }`,
);
const web3 = new Web3(provider);
const operationsWallet = web3.eth.accounts.wallet.add(
  operationsWalletPrivateKey,
);

async function sendTokenTransaction(toAddress, amount) {
  const erc20Abi = [
    "function transfer(address to, uint256 amount) returns (bool)",
  ];
  const contract = new web3.eth.Contract(erc20Abi, PSPN_TOKEN_ADDRESS, {
    from: operationsWallet.address,
  });
  return contract.methods.transfer(toAddress, web3.utils.toWei(amount, "ether"))
    .send({ from: operationsWallet.address });
}

// Edge Function 시작
serve(async (req) => {
  const { userId, cropId, action, toAddress, amount } = await req.json();
  if (!userId || !cropId || !action || !toAddress || !amount) {
    return new Response("Invalid data provided", { status: 400 });
  }

  const transactionType = action === "buy" ? "purchase" : "sale";
  const status = "pending";

  // 트랜잭션 기록 추가
  const { data, error } = await supabase
    .from("transactions")
    .insert([
      {
        user_id: userId,
        item_id: cropId,
        item_type: "CROP",
        amount,
        status,
        tx_hash: null,
      },
    ])
    .select();

  if (error) {
    console.error("Error recording transaction:", error);
    return new Response("Failed to record transaction", { status: 500 });
  }

  try {
    // 송금 요청 처리 (PSPN 토큰 전송)
    const tx = await sendTokenTransaction(toAddress, amount);
    await supabase
      .from("transactions")
      .update({ status: "completed", tx_hash: tx.transactionHash })
      .eq("id", data[0].id);

    return new Response(
      JSON.stringify({ success: true, txHash: tx.transactionHash }),
      { status: 200 },
    );
  } catch (error) {
    console.error("Token transaction failed:", error);
    await supabase
      .from("transactions")
      .update({ status: "failed" })
      .eq("id", data[0].id);
    return new Response("Transaction failed", { status: 500 });
  }
});
