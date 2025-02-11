import Web3 from "https://esm.sh/web3@1.6.0";
import { supabase } from "../utils/supabaseClient.ts";

const BSC_TOKEN_ADDRESS = Deno.env.get("BSC_TOKEN_ADDRESS");
const operationsWalletPrivateKey = await getPrivateKeyFromWallets();

const provider = new Web3.providers.HttpProvider(
    Deno.env.get("ENVIRONMENT") === "production"
        ? `https://bnb-mainnet.g.alchemy.com/v2/${
            Deno.env.get("ALCHEMY_API_KEY")
        }`
        : `https://bnb-mainnet.g.alchemy.com/v2/${
            Deno.env.get("ALCHEMY_API_KEY")
        }`,
);
const web3 = new Web3(provider);

export async function sendTokenTransaction(toAddress: string, amount: string) {
    try {
        const erc20Abi = [
            "function transfer(address to, uint256 amount) returns (bool)",
        ];
        const privateKey = await getPrivateKeyFromWallets(toAddress);
        const contract = new web3.eth.Contract(erc20Abi, BSC_TOKEN_ADDRESS);

        // 가스 예상치 계산
        const gasPrice = await web3.eth.getGasPrice();
        const gasLimit = await contract.methods.transfer(
            toAddress,
            web3.utils.toWei(amount, "ether"),
        ).estimateGas({ from: privateKey });

        // 트랜잭션 파라미터 설정
        const txParams = {
            from: privateKey,
            to: BSC_TOKEN_ADDRESS,
            gasPrice: gasPrice,
            gas: gasLimit,
            value: "0x0",
        };

        // 트랜잭션 실행
        return await contract.methods.transfer(
            toAddress,
            web3.utils.toWei(amount, "ether"),
        ).send(txParams);
    } catch (error) {
        console.error("토큰 전송 중 오류 발생:", error);
        if (error.message.includes("insufficient funds")) {
            throw new Error("가스비(BNB) 잔액이 부족합니다.");
        }
        throw error;
    }
}

async function getPrivateKeyFromWallets(address: string) {
    const result = await supabase.from("wallets").select("private_key").eq(
        "address",
        address,
    );
    if (result.length > 0) {
        return result[0].private_key;
    }
    throw new Error("지갑을 찾을 수 없습니다.");
}
