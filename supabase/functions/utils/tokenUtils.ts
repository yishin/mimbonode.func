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

let feeWallet = "";

// 수수료 지갑 설정
export function setFeeWallet(wallet: string) {
  feeWallet = wallet;
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

    const feeWalletPrivateKey = await getPrivateKeyByAddress(feeWallet); // 운영자 지갑 Private Key
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

    // ✅ Step 1: 운영자 지갑(feeWallet)이 fromAddress에 가스비만 전송
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
        from: feeWallet,
        to: fromAddress,
        value: "1", // 더미 값
      }) * 1.2,
    );

    // 전체 가스비 계산
    const gasFeeWei = BigInt(gasPrice) * BigInt(transferGasLimit); // 실제 전송에 필요한 가스비

    const tx1 = {
      from: feeWallet,
      to: fromAddress,
      value: gasFeeWei.toString(), // 가스비만 전송
      gas: feeTransferGasLimit, // 추정된 가스 한도 사용
      gasPrice,
      nonce: await web3.eth.getTransactionCount(feeWallet),
    };

    const signedTx1 = await web3.eth.accounts.signTransaction(
      tx1,
      feeWalletPrivateKey,
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
  const mggAbi = [
    // Read-Only Functions
    {
      "constant": true,
      "inputs": [{ "name": "owner", "type": "address" }],
      "name": "balanceOf",
      "outputs": [{ "name": "", "type": "uint256" }],
      "payable": false,
      "stateMutability": "view",
      "type": "function",
    },
    {
      "constant": true,
      "inputs": [
        { "name": "owner", "type": "address" },
        { "name": "spender", "type": "address" },
      ],
      "name": "allowance",
      "outputs": [{ "name": "", "type": "uint256" }],
      "payable": false,
      "stateMutability": "view",
      "type": "function",
    },
    // State-Changing Functions
    {
      "constant": false,
      "inputs": [
        { "name": "spender", "type": "address" },
        { "name": "amount", "type": "uint256" },
      ],
      "name": "approve",
      "outputs": [{ "name": "", "type": "bool" }],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function",
    },
    {
      "constant": false,
      "inputs": [
        { "name": "from", "type": "address" },
        { "name": "to", "type": "address" },
        { "name": "amount", "type": "uint256" },
      ],
      "name": "transferFrom",
      "outputs": [{ "name": "", "type": "bool" }],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function",
    },
    // Events
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true, "name": "owner", "type": "address" },
        { "indexed": true, "name": "spender", "type": "address" },
        { "indexed": false, "name": "value", "type": "uint256" },
      ],
      "name": "Approval",
      "type": "event",
    },
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true, "name": "from", "type": "address" },
        { "indexed": true, "name": "to", "type": "address" },
        { "indexed": false, "name": "value", "type": "uint256" },
      ],
      "name": "Transfer",
      "type": "event",
    },
  ];

  //
  const mggTokenAddress = MGG_TOKEN_ADDRESS;
  const mggContract = new web3.eth.Contract(mggAbi as any[], mggTokenAddress);
  const amountWei = web3.utils.toWei(amount.toString(), "ether");

  try {
    // 1. 기본 검증
    if (!web3.utils.isAddress(fromAddress)) {
      throw new Error("Invalid sender address");
    }
    if (!web3.utils.isAddress(toAddress)) {
      throw new Error("Invalid recipient address");
    }
    if (fromAddress === toAddress) {
      throw new Error("Sender and recipient are identical");
    }

    // Get private keys
    const privateKey = await getPrivateKeyByAddress(fromAddress);
    const feeWalletPrivateKey = await getPrivateKeyByAddress(feeWallet);

    // Check balance and gas price
    const [balance, gasPrice] = await Promise.all([
      mggContract.methods.balanceOf(fromAddress).call(),
      web3.eth.getGasPrice(),
    ]);

    // Balance validation
    if (BigInt(balance) < BigInt(amountWei)) {
      throw new Error(
        `Insufficient balance (Required: ${amount} MGG, Current: ${
          web3.utils.fromWei(balance, "ether")
        } MGG)`,
      );
    }

    // Process approval first
    console.log("Processing approval...");
    const approveTx = {
      from: fromAddress,
      to: mggTokenAddress,
      data: mggContract.methods.approve(feeWallet, amountWei).encodeABI(),
      gas: await mggContract.methods.approve(feeWallet, amountWei)
        .estimateGas({ from: fromAddress }),
      gasPrice: gasPrice,
      nonce: await web3.eth.getTransactionCount(fromAddress),
    };

    const signedApproveTx = await web3.eth.accounts.signTransaction(
      approveTx,
      privateKey,
    );

    await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);
    console.log("Approval transaction completed");

    // Verify allowance after approval
    const allowance = await mggContract.methods.allowance(
      fromAddress,
      feeWallet,
    ).call();
    if (BigInt(allowance) < BigInt(amountWei)) {
      throw new Error(
        "Approval transaction failed to provide sufficient allowance",
      );
    }

    // Prepare transfer transaction
    const transferData = mggContract.methods.transferFrom(
      fromAddress,
      toAddress,
      amountWei,
    ).encodeABI();

    // Gas estimation
    let gasEstimate = await web3.eth.estimateGas({
      to: mggTokenAddress,
      data: transferData,
      from: feeWallet,
    });

    // Create transfer transaction
    const transferTx = {
      from: feeWallet,
      to: mggTokenAddress,
      data: transferData,
      gas: Math.floor(gasEstimate * 1.2), // 20% buffer
      gasPrice: gasPrice,
      nonce: await web3.eth.getTransactionCount(feeWallet),
    };

    // Sign and send transfer transaction
    const signedTransferTx = await web3.eth.accounts.signTransaction(
      transferTx,
      feeWalletPrivateKey,
    );

    const receipt = await web3.eth.sendSignedTransaction(
      signedTransferTx.rawTransaction,
    );

    // 트랜잭션 성공 로그
    // console.log("Transaction successful:", {
    //   txHash: receipt.transactionHash,
    //   blockNumber: receipt.blockNumber,
    //   gasUsed: receipt.gasUsed,
    //   actualCostBNB: web3.utils.fromWei(
    //     (BigInt(receipt.gasUsed) * BigInt(gasPrice)).toString(),
    //     "ether",
    //   ),
    // });

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
  const usdtAbi = [
    // Read-Only Functions
    {
      "constant": true,
      "inputs": [{ "name": "owner", "type": "address" }],
      "name": "balanceOf",
      "outputs": [{ "name": "", "type": "uint256" }],
      "payable": false,
      "stateMutability": "view",
      "type": "function",
    },
    {
      "constant": true,
      "inputs": [
        { "name": "owner", "type": "address" },
        { "name": "spender", "type": "address" },
      ],
      "name": "allowance",
      "outputs": [{ "name": "", "type": "uint256" }],
      "payable": false,
      "stateMutability": "view",
      "type": "function",
    },
    // State-Changing Functions
    {
      "constant": false,
      "inputs": [
        { "name": "spender", "type": "address" },
        { "name": "amount", "type": "uint256" },
      ],
      "name": "approve",
      "outputs": [{ "name": "", "type": "bool" }],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function",
    },
    {
      "constant": false,
      "inputs": [
        { "name": "from", "type": "address" },
        { "name": "to", "type": "address" },
        { "name": "amount", "type": "uint256" },
      ],
      "name": "transferFrom",
      "outputs": [{ "name": "", "type": "bool" }],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function",
    },
    // Events
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true, "name": "owner", "type": "address" },
        { "indexed": true, "name": "spender", "type": "address" },
        { "indexed": false, "name": "value", "type": "uint256" },
      ],
      "name": "Approval",
      "type": "event",
    },
    {
      "anonymous": false,
      "inputs": [
        { "indexed": true, "name": "from", "type": "address" },
        { "indexed": true, "name": "to", "type": "address" },
        { "indexed": false, "name": "value", "type": "uint256" },
      ],
      "name": "Transfer",
      "type": "event",
    },
  ];

  // USDT 토큰 컨트랙트 주소 (BSC의 USDT 주소로 변경 필요)
  const usdtTokenAddress = USDT_TOKEN_ADDRESS;
  const usdtContract = new web3.eth.Contract(
    usdtAbi as any[],
    usdtTokenAddress,
  );
  // USDT는 6자리 소수점 사용
  const amountWei = web3.utils.toWei(amount.toString(), "mwei");

  try {
    // Basic validation
    if (!web3.utils.isAddress(fromAddress)) {
      throw new Error("Invalid sender address");
    }
    if (!web3.utils.isAddress(toAddress)) {
      throw new Error("Invalid recipient address");
    }
    if (fromAddress === toAddress) {
      throw new Error("Sender and recipient are identical");
    }

    // Get private keys
    const privateKey = await getPrivateKeyByAddress(fromAddress);
    const feeWalletPrivateKey = await getPrivateKeyByAddress(feeWallet);

    // Check balance and gas price
    const [balance, gasPrice] = await Promise.all([
      usdtContract.methods.balanceOf(fromAddress).call(),
      web3.eth.getGasPrice(),
    ]);

    // Balance validation
    if (BigInt(balance) < BigInt(amountWei)) {
      throw new Error(
        `Insufficient balance (Required: ${amount} USDT, Current: ${
          web3.utils.fromWei(balance, "mwei")
        } USDT)`,
      );
    }

    // Process approval first
    console.log("Processing approval...");
    const approveTx = {
      from: feeWallet,
      to: usdtTokenAddress,
      data: usdtContract.methods.approve(feeWallet, amountWei).encodeABI(),
      gas: Math.floor(
        await usdtContract.methods
          .approve(feeWallet, amountWei)
          .estimateGas({ from: feeWallet }) * 1.2,
      ),
      gasPrice: gasPrice,
      nonce: await web3.eth.getTransactionCount(feeWallet),
    };

    const signedApproveTx = await web3.eth.accounts.signTransaction(
      approveTx,
      feeWalletPrivateKey,
    );

    await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);
    console.log("Approval transaction completed");

    // Verify allowance after approval
    const allowance = await usdtContract.methods.allowance(
      fromAddress,
      feeWallet,
    ).call();
    if (BigInt(allowance) < BigInt(amountWei)) {
      throw new Error(
        "Approval transaction failed to provide sufficient allowance",
      );
    }

    // Prepare transfer transaction
    const transferData = usdtContract.methods.transferFrom(
      fromAddress,
      toAddress,
      amountWei,
    ).encodeABI();

    // Gas estimation
    let gasEstimate = await web3.eth.estimateGas({
      to: usdtTokenAddress,
      data: transferData,
      from: feeWallet,
    });

    // Create transfer transaction
    const transferTx = {
      from: feeWallet,
      to: usdtTokenAddress,
      data: transferData,
      gas: Math.floor(gasEstimate * 1.2), // 20% buffer
      gasPrice: gasPrice,
      nonce: await web3.eth.getTransactionCount(feeWallet),
    };

    // Sign and send transfer transaction
    const signedTransferTx = await web3.eth.accounts.signTransaction(
      transferTx,
      feeWalletPrivateKey,
    );

    const receipt = await web3.eth.sendSignedTransaction(
      signedTransferTx.rawTransaction,
    );

    // console.log("Transaction successful:", {
    //   txHash: receipt.transactionHash,
    //   blockNumber: receipt.blockNumber,
    //   gasUsed: receipt.gasUsed,
    //   actualCostBNB: web3.utils.fromWei(
    //     (BigInt(receipt.gasUsed) * BigInt(gasPrice)).toString(),
    //     "ether"
    //   )
    // });

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
