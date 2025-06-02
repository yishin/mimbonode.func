import Web3 from "https://esm.sh/web3@1.10.0";
import { supabase } from "../utils/supabaseClient.ts";
import { decryptPrivateKey } from "./cryptoUtils.ts";

// Smart Contract Address
const MGG_TOKEN_ADDRESS = Deno.env.get("MGG_TOKEN_ADDRESS");
const USDT_TOKEN_ADDRESS = Deno.env.get("USDT_TOKEN_ADDRESS");

const endpointUrl = Deno.env.get("ENVIRONMENT") === "production"
  ? Deno.env.get("QUICKNODE_HTTP_ENDPOINT") //`https://bnb-mainnet.g.alchemy.com/v2/${Deno.env.get("ALCHEMY_API_KEY")}`
  : Deno.env.get("QUICKNODE_HTTP_ENDPOINT");

const provider = new Web3.providers.HttpProvider(endpointUrl);
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
  // ERC-20 표준 함수들
  {
    "constant": true,
    "inputs": [],
    "name": "name",
    "outputs": [{ "name": "", "type": "string" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{ "name": "", "type": "string" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [],
    "name": "totalSupply",
    "outputs": [{ "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  {
    "constant": false,
    "inputs": [{ "name": "_to", "type": "address" }, {
      "name": "_value",
      "type": "uint256",
    }],
    "name": "transfer",
    "outputs": [{ "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function",
  },
  {
    "constant": false,
    "inputs": [{ "name": "_from", "type": "address" }, {
      "name": "_to",
      "type": "address",
    }, { "name": "_value", "type": "uint256" }],
    "name": "transferFrom",
    "outputs": [{ "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function",
  },
  {
    "constant": false,
    "inputs": [{ "name": "_spender", "type": "address" }, {
      "name": "_value",
      "type": "uint256",
    }],
    "name": "approve",
    "outputs": [{ "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function",
  },
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }, {
      "name": "_spender",
      "type": "address",
    }],
    "name": "allowance",
    "outputs": [{ "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function",
  },
  // Transfer 이벤트 (트랜잭션 조회에 필요)
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
      `🔋 Send gas fee: ${fromAddress}`,
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
      `🔶 Send BNB: ${fromAddress} → ${toAddress} ${amount} BNB`,
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

    // 가스 한도 추정 및 100% 버퍼 추가
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
      }) * 2.0,
    ); // 100% 버퍼 추가

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
        `🔋 Gas fee sent: ${
          web3.utils.fromWei(neededGas.toString(), "ether")
        } BNB`,
      );

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // 논스 충돌 방지
    let isNonceError = false;
    let retryCount = 0;
    const maxRetries = 2; // 최대 2번 재시도

    do {
      isNonceError = false;
      try {
        // 매번 새로운 논스 가져오기
        const nonce = await web3.eth.getTransactionCount(
          fromAddress,
          "pending",
        );

        const transferTx = {
          from: fromAddress,
          to: MGG_TOKEN_ADDRESS,
          gas: gasLimit,
          gasPrice,
          nonce, // 새로운 논스 사용
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
      } catch (txError) {
        console.error("❌ MGG transfer failed:", txError);

        // 논스 관련 오류 체크
        if (
          txError.message && (
            txError.message.includes("replacement transaction underpriced") ||
            txError.message.includes("nonce too low") ||
            txError.message.includes("could not replace existing tx")
          )
        ) {
          isNonceError = true;
          retryCount++;

          console.log(`❗ Nonce collision detected, ${retryCount}th retry...`);

          // 재시도 전 잠시 대기
          await new Promise((resolve) =>
            setTimeout(resolve, 1500 * retryCount)
          );

          if (retryCount > maxRetries) {
            throw new Error(
              "❌ Maximum retry count exceeded: " + txError.message,
            );
          }
        } else {
          // 다른 종류의 오류는 그대로 던짐
          throw txError;
        }
      }
    } while (isNonceError && retryCount <= maxRetries);
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
        `🔋 Gas fee sent: ${
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
      `💰 USDT transfer complete: ${amount} USDT (${fromAddress} → ${toAddress})`,
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

/**
 * 주어진 주소로 받은 마지막 USDT 트랜잭션 해시를 가져옵니다.
 *
 * @param address - 조회할 지갑 주소
 * @returns 마지막으로 받은 USDT 트랜잭션 해시 또는 null
 */
export async function getUsdtLastTx(address) {
  try {
    if (!web3.utils.isAddress(address)) {
      throw new Error("Invalid address");
    }

    // USDT 컨트랙트 인스턴스 생성
    const usdtContract = new web3.eth.Contract(
      USDT_ABI,
      USDT_TOKEN_ADDRESS,
    );

    // 검색 전략: 여러 블록 범위를 순차적으로 검색
    const blockRanges = [
      { fromBlock: "latest", toBlock: "latest", desc: "최신 블록" },
      { fromBlock: -50000, toBlock: "latest", desc: "최근 50,000 블록" },
      { fromBlock: -200000, toBlock: -50001, desc: "50,001-200,000 블록 전" },
      { fromBlock: -500000, toBlock: -200001, desc: "200,001-500,000 블록 전" },
      {
        fromBlock: -1000000,
        toBlock: -500001,
        desc: "500,001-1,000,000 블록 전",
      }, // 1백만 = 약 34.8일
    ];

    for (const range of blockRanges) {
      console.log(`Searching in ${range.desc}`);

      try {
        // 상대적 블록 번호를 절대적 블록 번호로 변환
        let fromBlock = range.fromBlock;
        let toBlock = range.toBlock;

        const currentBlock = await web3.eth.getBlockNumber();

        if (fromBlock === "latest") {
          fromBlock = currentBlock;
        } else if (typeof fromBlock === "number" && fromBlock < 0) {
          fromBlock = Math.max(0, currentBlock + fromBlock); // 음수 값은 현재 블록에서 뺌
        }

        if (toBlock === "latest") {
          toBlock = currentBlock;
        } else if (typeof toBlock === "number" && toBlock < 0) {
          toBlock = Math.max(0, currentBlock + toBlock);
        }

        console.log(`Searching from block ${fromBlock} to ${toBlock}`);

        // 이벤트 필터 생성 (해당 주소가 수신자(to)인 Transfer 이벤트만 조회)
        const toEvents = await usdtContract.getPastEvents("Transfer", {
          filter: { to: address },
          fromBlock,
          toBlock,
        });

        if (toEvents.length > 0) {
          // 블록 번호로 정렬하여 가장 최근 트랜잭션 찾기
          toEvents.sort((a, b) => b.blockNumber - a.blockNumber);

          // 가장 최근 이벤트의 트랜잭션 해시 반환
          const find = {
            txHash: toEvents[0].transactionHash,
            txAddress: toEvents[0].returnValues.from,
            txBlock: toEvents[0].blockNumber,
          };
          console.log(
            `Found transaction: ${find.txHash} at block ${
              toEvents[0].blockNumber
            }`,
          );
          return find;
        }
      } catch (rangeError) {
        console.log(`Error searching in range ${range.desc}:`, rangeError);
        // 이 범위에서 오류가 발생하면 다음 범위로 계속 진행
        continue;
      }
    }

    // 모든 범위에서 트랜잭션을 찾지 못한 경우
    console.log(
      `No USDT transactions found for address: ${address} after searching all ranges`,
    );
    return null;
  } catch (error) {
    console.error("Error in getUsdtLastTx:", error);
    return null;
  }
}
