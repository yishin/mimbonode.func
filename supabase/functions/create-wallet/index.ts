import Web3 from "https://esm.sh/web3@1.10.0";
import * as bip39 from "https://esm.sh/bip39@3.0.4";
// import HDKey from "https://esm.sh/hdkey@1.1.0";
import HDKey from "npm:hdkey@1.1.0";

import { supabase } from "../utils/supabaseClient.ts";
import { encryptPrivateKey } from "../utils/cryptoUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";

// Alchemy API
const alchemyApiUrl = Deno.env.get("ALCHEMY_API_URL");
const hdWalletMasterMnemonic = Deno.env.get("HDWALLET_MASTER_MNEMONIC");
const walletKeyPassword = Deno.env.get("WALLET_KEY_PASSWORD");

export class HDWallet {
  private web3: Web3;
  private hdKey: HDKey;

  constructor() {
    this.web3 = new Web3(alchemyApiUrl);

    const seed = bip39.mnemonicToSeedSync(hdWalletMasterMnemonic);
    // console.log("seed: " + seed.toString("hex"));
    this.hdKey = HDKey.fromMasterSeed(seed);
    // console.log("hdkey:" + JSON.stringify(this.hdKey));
  }

  // HD Wallet에서 SID 기반으로 child wallet 생성
  async createWallet(sid: number) {
    const childKey = this.hdKey.derive(`m/44'/60'/0'/0/${sid}`); // SID로 child wallet 생성

    const walletPrivateKey = `0x${childKey.privateKey.toString("hex")}`;

    const wallet = this.web3.eth.accounts.privateKeyToAccount(walletPrivateKey); // child wallet 생성
    // console.log("wallet:" + JSON.stringify(wallet));

    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  }

  // 지갑 정보를 Supabase wallets 테이블에 업데이트
  async updateWalletInSupabase(
    user_id: string,
    address: string,
    privateKey: string,
  ) {
    const { error } = await supabase
      .from("wallets")
      .update({ address: address, private_key: privateKey })
      .eq("user_id", user_id);

    if (error) {
      console.log(
        "updateWalletInSupabase error: " +
          JSON.stringify(error?.message || "error"),
      );

      return false;
    }
    return true;
  }

  // 지갑 생성 및 저장
  async createAndSaveWallet(user_id: string) {
    // 이미 지갑이 존재하는지 확인
    const { data: userWallet, error: selectError } = await supabase
      .from("wallets")
      .select("sid, address, private_key")
      .eq("user_id", user_id)
      .single();

    if (selectError && selectError.code !== "PGRST116") { // 지갑이 없는 경우는 괜찮고, 그 외는 오류 처리
      throw selectError;
    }

    // address와 private_key가 이미 존재하는지 확인
    if (
      userWallet && userWallet?.address?.length > 0 &&
      userWallet?.private_key?.length > 0
    ) {
      return userWallet.address; // 이미 지갑이 존재하면 새로 생성하지 않음
    }

    // 지갑이 없으면 새로 생성하여 저장
    console.log("createWallet sid: " + userWallet.sid);

    const wallet = await this.createWallet(userWallet.sid);
    console.log("wallet created: " + JSON.stringify(wallet?.address || ""));

    // privateKey는 암호화
    const encPrivateKey = await encryptPrivateKey(
      wallet.privateKey,
      `${user_id}${walletKeyPassword}`,
    );

    const savedWallet = await this.updateWalletInSupabase(
      user_id,
      wallet.address,
      encPrivateKey,
    );
    if (savedWallet) {
      console.log("savedWallet: " + JSON.stringify(wallet.address));
      return wallet.address;
    }

    return "error";
  }

  // 지갑 잔액 조회
  async getBalance(address: string) {
    const balance = await this.web3.eth.getBalance(address);
    return this.web3.utils.fromWei(balance, "ether");
  }
}

// Supabase Edge Function handler
Deno.serve(async (req) => {
  const headers = setCorsHeaders(req);

  // Preflight 요청 처리 (OPTIONS 메서드)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  //
  if (!alchemyApiUrl) {
    return new Response(
      JSON.stringify({ error: "Alchemy API URL not found" }),
      { status: 500, headers },
    );
  }
  if (!hdWalletMasterMnemonic) {
    return new Response(
      JSON.stringify({ error: "HD Wallet master key not found" }),
      { status: 500, headers },
    );
  }

  // Start...
  const hdWallet = new HDWallet();

  if (req.method === "POST") {
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
      console.log(`user_id: ${authResult.profile.username} (${user.id})`);

      // post data 추출
      let walletAddress = "";
      const { user_id, sid } = await req.json();
      console.log("wallet create user_id:" + user_id, " sid:" + sid);

      // user_id가 없으면 에러
      if (!user_id) {
        return new Response(
          JSON.stringify({ error: "Invalid post" }),
          {
            status: 400,
            headers,
          },
        );
      }

      // sid가 1000 이하인 경우는 관리자 지갑, 1001 이상인 경우는 사용자 지갑 생성
      if (sid > 1000) {
        console.log("사용자 지갑생성");
        // 사용자 지갑 생성 및 저장
        walletAddress = await hdWallet.createAndSaveWallet(user.id);
      } else {
        console.log("관리자 지갑 생성");

        // wallet_id와 sid로 wallet 레코드 조회
        const { data: wallet, error: walletError } = await supabase
          .from("wallets")
          .select("user_id, address, private_key")
          .eq("user_id", user_id)
          .eq("sid", sid)
          .single();
        console.log("wallet:" + JSON.stringify(wallet));
        if (walletError) {
          return new Response(JSON.stringify({ error: walletError.message }), {
            status: 500,
            headers,
          });
        }
        // 지갑이 이미 존재하는 경우
        if (wallet.address && wallet.private_key) {
          return new Response(
            JSON.stringify({ error: "Wallet already exists" }),
            {
              status: 400,
              headers,
            },
          );
        }

        // user_id가 일치하는지 검증
        if (!wallet || !wallet.user_id || wallet.user_id !== user_id) {
          return new Response(
            JSON.stringify({ error: "Wallet not found or user_id unmatched" }),
            {
              status: 404,
              headers,
            },
          );
        }

        // user.roles에 admin 권한이 없는 경우
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("user_role")
          .eq("user_id", user.id)
          .single();

        console.log("profile:" + JSON.stringify(profile));

        if (profileError) {
          return new Response(
            JSON.stringify({ error: profileError.message }),
            {
              status: 500,
              headers,
            },
          );
        }

        // console.log("user.roles:" + JSON.stringify(userRoles));
        if (profile.user_role === "admin") {
          // 지갑 생성 및 저장
          walletAddress = await hdWallet.createAndSaveWallet(wallet.user_id);
          console.log("wallet created: " + JSON.stringify(walletAddress));
        } else {
          return new Response(
            JSON.stringify({ error: "Unauthorized wallet admin" }),
            {
              status: 403,
              headers,
            },
          );
        }
      }

      // 성공인 경우 지갑 주소 반환
      return new Response(
        JSON.stringify({
          user_id: user_id ? user_id : user.id,
          address: walletAddress,
        }),
        {
          status: 200,
          headers,
        },
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error?.message || "error" }),
        {
          status: 500,
          headers,
        },
      );
    }
  } else {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }
});
