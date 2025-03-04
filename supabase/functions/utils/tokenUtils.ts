import Web3 from "https://esm.sh/web3@1.10.0";
import { supabase } from "../utils/supabaseClient.ts";
import { decryptPrivateKey } from "./cryptoUtils.ts";

// Smart Contract Address
const MGG_TOKEN_ADDRESS = Deno.env.get("MGG_TOKEN_ADDRESS");
const USDT_TOKEN_ADDRESS = Deno.env.get("USDT_TOKEN_ADDRESS");

const alchemyUrl = Deno.env.get("ENVIRONMENT") === "production"
  ? `https://bnb-mainnet.g.alchemy.com/v2/${Deno.env.get("ALCHEMY_API_KEY")}`
  : `https://bnb-mainnet.g.alchemy.com/v2/${Deno.env.get("ALCHEMY_API_KEY")}`;

const provider = new Web3.providers.HttpProvider(alchemyUrl);
const web3 = new Web3(provider);

// 수수료를 지급하는 운영용 지갑 설정
let operationWallet = "";
export function setOperationWallet(wallet: string) {
  operationWallet = wallet;
}

// 지갑의 개인키 가져오기
async function getPrivateKeyByAddress(address: string) {
  const { data, error } = await supabase.from("wallets").select(
    "user_id, private_key",
  )
    .eq(
      "address",
      address,
    ).single();
  if (error) {
    throw new Error("Wallet not found");
  }

  // 키 복호화
  const keyPassword = Deno.env.get("WALLET_KEY_PASSWORD");
  if (!keyPassword) {
    throw new Error("WALLET_KEY_PASSWORD is not set");
  }
  const key = await decryptPrivateKey(
    data.private_key,
    data.user_id + keyPassword,
  );
  return key;
}

// 컨트랙트 ABI
const MGG_ABI = [
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "type": "function",
  },
  {
    "constant": false,
    "inputs": [
      { "name": "_to", "type": "address" },
      { "name": "_value", "type": "uint256" },
    ],
    "name": "transfer",
    "outputs": [{ "name": "", "type": "bool" }],
    "type": "function",
  },
];

const USDT_ABI = [
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "type": "function",
  },
  {
    "constant": false,
    "inputs": [
      { "name": "_to", "type": "address" },
      { "name": "_value", "type": "uint256" },
    ],
    "name": "transfer",
    "outputs": [{ "name": "", "type": "bool" }],
    "type": "function",
  },
];

/**
 * BNB 잔액 확인
 *
 * @param address - 주소
 * @returns {Object} 잔액 객체
 */
export async function getBnbBalance(address: string) {
  const balance = await web3.eth.getBalance(address);
  return balance;
}

/**
 * MGG 잔액 확인
 *
 * @param address - 주소
 * @returns {Object} 잔액 객체
 */
export async function getMggBalance(address: string) {
  const mggContract = new web3.eth.Contract(
    MGG_ABI as any[],
    MGG_TOKEN_ADDRESS,
  );
  const balance = await mggContract.methods.balanceOf(address).call();
  const balanceFormatted = web3.utils.fromWei(balance.toString(), "ether");
  return balanceFormatted;
}

/**
 * USDT 잔액 확인
 *
 * @param address - 주소
 * @returns {Object} 잔액 객체
 */
export async function getUsdtBalance(address: string) {
  const usdtContract = new web3.eth.Contract(
    USDT_ABI as any[],
    USDT_TOKEN_ADDRESS,
  );
  const balance = await usdtContract.methods.balanceOf(address).call();
  const balanceFormatted = web3.utils.fromWei(balance.toString(), "ether");
  return balanceFormatted;
}
/**
 * BNB를 전송하는 함수
 * fromAddress에서는 순수 전송량만 차감되고, 가스비는 운영 지갑에서 지불
 *
 * @param fromAddress - 송신자 주소
 * @param toAddress - 수신자 주소
 * @param amount - 전송할 BNB 수량
 * @returns {Object} 전송 결과 객체
 */
export async function sendBnb(
  fromAddress: string,
  toAddress: string,
  amount: string,
) {
  try {
    if (
      !web3.utils.isAddress(fromAddress) || !web3.utils.isAddress(toAddress)
    ) {
      throw new Error("Invalid sender or recipient address");
    }
    if (fromAddress === toAddress) {
      throw new Error("Sender and recipient cannot be the same");
    }

    const operationWalletPrivateKey = await getPrivateKeyByAddress(
      operationWallet,
    ); // 운영자 지갑 Private Key
    const senderPrivateKey = await getPrivateKeyByAddress(fromAddress); // 발신자 지갑 Private Key
    const amountWei = web3.utils.toWei(amount.toString(), "ether");

    // fromAddress의 잔액 확인
    const balance = await web3.eth.getBalance(fromAddress);
    if (BigInt(balance) < BigInt(amountWei)) {
      throw new Error(
        `Insufficient balance (Required: ${amount} BNB, Current: ${
          web3.utils.fromWei(balance, "ether")
        } BNB)`,
      );
    }

    // ✅ Step 1: 운영자 지갑(operationWallet)이 fromAddress에 가스비만 전송
    const gasPrice = await web3.eth.getGasPrice();

    // 실제 전송에 필요한 가스 추정
    const transferGasLimit = Math.floor(
      await web3.eth.estimateGas({
        from: fromAddress,
        to: toAddress,
        value: amountWei,
      }) * 1.2,
    ); // 20% 버퍼 추가

    // 가스비 전송에 필요한 가스 추정
    const feeTransferGasLimit = Math.floor(
      await web3.eth.estimateGas({
        from: operationWallet,
        to: fromAddress,
        value: "1", // 더미 값
      }) * 1.2,
    );

    // 전체 가스비 계산
    const gasFeeWei = BigInt(gasPrice) * BigInt(transferGasLimit); // 실제 전송에 필요한 가스비

    const tx1 = {
      from: operationWallet,
      to: fromAddress,
      value: gasFeeWei.toString(), // 가스비만 전송
      gas: feeTransferGasLimit, // 추정된 가스 한도 사용
      gasPrice,
      nonce: await web3.eth.getTransactionCount(operationWallet),
    };

    const signedTx1 = await web3.eth.accounts.signTransaction(
      tx1,
      operationWalletPrivateKey,
    );
    const receipt1 = await web3.eth.sendSignedTransaction(
      signedTx1.rawTransaction,
    );
    console.log(
      `✅ Step 1 완료: 운영자 지갑이 fromAddress(${fromAddress})에 가스비 전송 완료`,
    );

    // ✅ Step 2: fromAddress가 toAddress로 BNB 전송
    const tx2 = {
      from: fromAddress,
      to: toAddress,
      value: amountWei,
      gas: transferGasLimit,
      gasPrice,
      nonce: await web3.eth.getTransactionCount(fromAddress),
    };

    const signedTx2 = await web3.eth.accounts.signTransaction(
      tx2,
      senderPrivateKey,
    );
    const receipt2 = await web3.eth.sendSignedTransaction(
      signedTx2.rawTransaction,
    );
    console.log(
      `✅ Step 2 완료: fromAddress(${fromAddress}) → toAddress(${toAddress}) ${amount} BNB 전송 완료`,
    );

    return {
      success: true,
      prepareTxHash: receipt1.transactionHash, // 가스비 전송 트랜잭션 해시
      txHash: receipt2.transactionHash, // 실제 전송 트랜잭션 해시
      gasUsed: {
        prepare: receipt1.gasUsed, // 가스비 전송에 사용된 가스
        transfer: receipt2.gasUsed, // 실제 전송에 사용된 가스
      },
      blockNumber: {
        prepare: receipt1.blockNumber, // 가스비 전송 블록 번호
        transfer: receipt2.blockNumber, // 실제 전송 블록 번호
      },
    };
  } catch (error) {
    console.error("❌ BNB 전송 실패:", {
      error: error.message || "Unknown error",
      fromAddress,
      toAddress,
      amount,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error: error.message || "Unknown error",
      details: { fromAddress, toAddress, amount },
    };
  }
}

/**
 * MGG 전송
 * fromAddress에서 MGG가 출금되고, 가스비는 운영 지갑에서 지불
 *
 * @param fromAddress - 송신자 주소
 * @param toAddress - 수신자 주소
 * @param amount - 전송할 MGG 수량
 * @returns {Object} 전송 결과 객체
 */
export async function sendMgg(
  fromAddress: string,
  toAddress: string,
  amount: string,
) {
  //
  try {
    if (
      !web3.utils.isAddress(fromAddress) || !web3.utils.isAddress(toAddress)
    ) {
      throw new Error("Invalid sender or recipient address");
    }

    const operationWalletPrivateKey = await getPrivateKeyByAddress(
      operationWallet,
    );
    const senderPrivateKey = await getPrivateKeyByAddress(fromAddress);

    // MGG 컨트랙트 인스턴스 생성
    const mggContract = new web3.eth.Contract(
      MGG_ABI as any[],
      MGG_TOKEN_ADDRESS,
    );

    // 가스비 계산
    const gasPrice = await web3.eth.getGasPrice();

    // 가스 한도 추정 및 20% 버퍼 추가
    const amountToSend = web3.utils.toWei(amount.toString(), "ether");
    const transferData = mggContract.methods.transfer(
      toAddress,
      amountToSend.toString(),
    ).encodeABI();

    const estimatedGas = Math.floor(
      await web3.eth.estimateGas({
        from: fromAddress,
        to: MGG_TOKEN_ADDRESS,
        data: transferData,
      }) * 1.2,
    ); // 20% 버퍼 추가

    const gasLimit = estimatedGas;
    const gasFee = BigInt(gasPrice) * BigInt(gasLimit);

    // BNB 잔액 확인
    const bnbBalance = await web3.eth.getBalance(fromAddress);
    const operationWalletBalance = await web3.eth.getBalance(operationWallet);

    // 운영 지갑 잔액 확인
    if (BigInt(operationWalletBalance) < gasFee) {
      throw new Error("Insufficient BNB balance in operation wallet for gas");
    }

    // 부족한 가스비만 전송
    if (BigInt(bnbBalance) < gasFee) {
      const neededGas = gasFee - BigInt(bnbBalance);

      const gasTx = {
        from: operationWallet,
        to: fromAddress,
        value: neededGas.toString(),
        gas: "21000",
        gasPrice,
        nonce: await web3.eth.getTransactionCount(operationWallet, "pending"),
      };

      const signedGasTx = await web3.eth.accounts.signTransaction(
        gasTx,
        operationWalletPrivateKey,
      );
      await web3.eth.sendSignedTransaction(signedGasTx.rawTransaction);
      console.log(
        `✅ Gas fee sent: ${
          web3.utils.fromWei(neededGas.toString(), "ether")
        } BNB`,
      );

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const nonce = await web3.eth.getTransactionCount(fromAddress, "pending");
    const transferTx = {
      from: fromAddress,
      to: MGG_TOKEN_ADDRESS,
      gas: gasLimit,
      gasPrice,
      nonce,
      data: transferData,
    };

    const signedTransferTx = await web3.eth.accounts.signTransaction(
      transferTx,
      senderPrivateKey,
    );
    const receipt = await web3.eth.sendSignedTransaction(
      signedTransferTx.rawTransaction,
    );

    if (!receipt.status) {
      throw new Error("Transaction failed");
    }

    console.log(
      `✅ MGG transfer complete: ${amount} MGG (${fromAddress} → ${toAddress})`,
    );

    return {
      success: true,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error("MGG transfer failed:", {
      error: error.message || "Unknown error",
      fromAddress,
      toAddress,
      amount,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error: error.message || "Unknown error",
      details: { fromAddress, toAddress, amount },
    };
  }
}

/**
 * USDT 전송
 * fromAddress에서 USDT가 출금되고, 가스비는 운영 지갑에서 지불
 *
 * @param fromAddress - 송신자 주소
 * @param toAddress - 수신자 주소
 * @param amount - 전송할 USDT 수량
 * @returns {Object} 전송 결과 객체
 */
export async function sendUsdt(
  fromAddress: string,
  toAddress: string,
  amount: string,
) {
  try {
    if (
      !web3.utils.isAddress(fromAddress) || !web3.utils.isAddress(toAddress)
    ) {
      throw new Error("Invalid sender or recipient address");
    }

    const operationWalletPrivateKey = await getPrivateKeyByAddress(
      operationWallet,
    );
    const senderPrivateKey = await getPrivateKeyByAddress(fromAddress);

    // USDT 컨트랙트 인스턴스 생성
    const usdtContract = new web3.eth.Contract(
      USDT_ABI as any[],
      USDT_TOKEN_ADDRESS,
    );

    // 가스비 계산
    const gasPrice = await web3.eth.getGasPrice();

    // USDT 전송 (6 decimals 사용)
    const amountToSend = web3.utils.toWei(amount.toString(), "ether");
    const transferData = usdtContract.methods.transfer(
      toAddress,
      amountToSend,
    ).encodeABI();

    // 가스 한도 추정 및 20% 버퍼 추가
    const estimatedGas = Math.floor(
      await web3.eth.estimateGas({
        from: fromAddress,
        to: USDT_TOKEN_ADDRESS,
        data: transferData,
      }) * 1.2,
    ); // 20% 버퍼 추가

    const gasLimit = estimatedGas;
    const gasFee = BigInt(gasPrice) * BigInt(gasLimit);

    // 보내는 지갑의 BNB 잔액 확인
    const bnbBalance = await web3.eth.getBalance(fromAddress);
    // 운영 지갑 잔액 확인
    const operationWalletBalance = await web3.eth.getBalance(operationWallet);
    if (BigInt(operationWalletBalance) < gasFee) {
      throw new Error("Insufficient BNB balance in operation wallet for gas");
    }

    // 부족한 가스비만 전송
    if (BigInt(bnbBalance) < gasFee) {
      const neededGas = gasFee - BigInt(bnbBalance);

      const gasTx = {
        from: operationWallet,
        to: fromAddress,
        value: neededGas.toString(),
        gas: "21000",
        gasPrice,
        nonce: await web3.eth.getTransactionCount(operationWallet, "pending"),
      };

      const signedGasTx = await web3.eth.accounts.signTransaction(
        gasTx,
        operationWalletPrivateKey,
      );
      await web3.eth.sendSignedTransaction(signedGasTx.rawTransaction);
      console.log(
        `✅ Gas fee sent: ${
          web3.utils.fromWei(neededGas.toString(), "ether")
        } BNB`,
      );

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const nonce = await web3.eth.getTransactionCount(fromAddress, "pending");
    const transferTx = {
      from: fromAddress,
      to: USDT_TOKEN_ADDRESS,
      gas: gasLimit,
      gasPrice,
      nonce,
      data: transferData,
    };

    const signedTransferTx = await web3.eth.accounts.signTransaction(
      transferTx,
      senderPrivateKey,
    );
    const receipt = await web3.eth.sendSignedTransaction(
      signedTransferTx.rawTransaction,
    );

    // ✅ 트랜잭션 상태 확인
    if (!receipt.status) {
      throw new Error("Transaction failed");
    }
    console.log(
      `✅ USDT transfer complete: ${amount} USDT (${fromAddress} → ${toAddress})`,
    );

    return {
      success: true,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error("USDT transfer failed:", {
      error: error.message || "Unknown error",
      fromAddress,
      toAddress,
      amount,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      error: error.message || "Unknown error",
      details: { fromAddress, toAddress, amount },
    };
  }
}
