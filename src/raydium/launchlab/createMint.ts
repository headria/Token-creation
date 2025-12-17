import {
  VersionedTransaction,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
  TransactionInstruction,
  TransactionMessage,
  PublicKey,
  Transaction
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "bn.js";
import {
  getATAAddress,
  buyExactInInstruction,
  getPdaLaunchpadAuth,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  TxVersion,
  LAUNCHPAD_PROGRAM,
  LaunchpadConfig,
} from "@raydium-io/raydium-sdk-v2";
import { initSdk } from "../config";
import { JitoTransactionExecutor } from "./executer";
import { LaunchpadRequest } from "../types/types";
import LaunchlabTokens from "../../db/models/letsBonk.launchlab";
import { FilebaseService } from "../../filebase";
import axios from "axios";
import * as dotenv from 'dotenv';

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_SENDER_ENDPOINT = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function sendWithHelius(transaction: VersionedTransaction): Promise<string> {
  try {
    console.log('\n=== Transaction Signing Started ===');
    console.log(`Signing with ${transaction.signatures.length} signers...`);

    // Serialize the transaction
    const serializedTx = transaction.serialize();
    const base64Tx = Buffer.from(serializedTx).toString('base64');
    console.log(`📄 Transaction serialized (${base64Tx.length} bytes)`);

    console.log('\n=== Sending Transaction via Helius ===');
    console.log(`🌐 Endpoint: ${HELIUS_SENDER_ENDPOINT}`);
    console.log('📤 Sending transaction data...');

    const startTime = Date.now();
    const response = await axios.post(
      HELIUS_SENDER_ENDPOINT,
      {
        jsonrpc: '2.0',
        id: Date.now().toString(),
        method: 'sendTransaction',
        params: [
          base64Tx,
          {
            encoding: 'base64',
            skipPreflight: true,
            maxRetries: 0,
            preflightCommitment: 'confirmed'
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 30000 // 30 seconds timeout
      }
    );

    const responseTime = Date.now() - startTime;
    console.log(`⏱️  Response received in ${responseTime}ms`);

    const json = response.data as { result?: string; error?: { message: string } };

    if (json.error) {
      console.error('❌ Helius Sender error:', JSON.stringify(json.error, null, 2));
      throw new Error(`Helius Sender error: ${json.error.message}`);
    }

    if (!json.result) {
      console.error('❌ No result returned from Helius Sender');
      throw new Error('No result returned from Helius Sender');
    }

    const signature = json.result;
    console.log(`✅ Transaction submitted successfully!`);
    console.log(`🔗 Signature: ${signature}`);
    console.log(`🌐 Explorer: https://explorer.solana.com/tx/${signature}`);

    console.log('\n=== Waiting for Confirmation ===');
    console.log('⏳ Waiting for transaction confirmation...');
    const confirmStartTime = Date.now();

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(
      signature,
      'confirmed'
    );

    const confirmTime = Date.now() - confirmStartTime;
    console.log(`✅ Transaction confirmed in ${confirmTime}ms`);
    console.log('📊 Confirmation details:', JSON.stringify({
      slot: confirmation.context.slot,
      confirmations: confirmation.value,
      status: confirmation.value.err ? 'failed' : 'success',
      error: confirmation.value.err
    }, null, 2));

    return signature;
  } catch (error) {
    console.error('❌ Error in sendWithHelius:', error instanceof Error ? error.message : 'Unknown error');
    if (axios.isAxiosError(error)) {
      console.error('📡 Axios error details:', {
        code: error.code,
        message: error.message,
        response: error.response?.data
      });
    }
    throw error;
  }
}

const BONK_PLATFROM_ID = new PublicKey(
  "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1"
);
const commitment = "confirmed";

const connection = new Connection(process.env.RPC_URL || "", {
  commitment,
});

const filebaseService = new FilebaseService();

const uploadImageToFilebase = async (imageData: Buffer, fileName: string): Promise<string> => {
  try {
    console.log("Uploading token image to Filebase...");
    
    // Upload image to Filebase
    const imageUrl = await filebaseService.uploadToFilebase(
      imageData, 
      `images/${Date.now()}-${fileName || 'token.png'}`,
      'image/png'
    );
    
    console.log('Image uploaded to Filebase:', imageUrl);
    return imageUrl;
  } catch (error) {
    console.error('Error uploading image to Filebase:', error);
    throw new Error(`Failed to upload image to Filebase: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const createBonkFunTokenMetadata = async (
  tokenData: LaunchpadRequest
) => {
  if (!tokenData.name || !tokenData.symbol || !tokenData.image) {
    throw new Error(
      "Missing required fields: name, symbol, and image are required"
    );
  }

  if (tokenData.name.length > 32) {
    throw new Error("Name must be 32 characters or less");
  }

  if (tokenData.symbol.length > 8) {
    throw new Error("Symbol must be 8 characters or less");
  }

  if (tokenData.description && tokenData.description.length > 200) {
    throw new Error("Description must be 200 characters or less");
  }

  if (tokenData.platformId) {
    try {
      new PublicKey(tokenData.platformId);
    } catch {
      throw new Error("platformId must be a valid Solana public key");
    }
  }

  try {
    console.log('Uploading token metadata to Filebase...');
    
    // Upload image to Filebase
    const imageUrl = await uploadImageToFilebase(
      tokenData.image,
      tokenData.imageFileName || 'token.png'
    );
    
    console.log('Image uploaded to Filebase:', imageUrl);

    // Prepare metadata
    const metadata = {
      name: tokenData.name,
      symbol: tokenData.symbol,
      description: tokenData.description || '',
      external_url: tokenData.website || 'https://bonk.fun',
      image: imageUrl,
      attributes: [
        {
          trait_type: 'Platform',
          value: 'Bonk Launchpad'
        },
        {
          trait_type: 'Created On',
          value: tokenData.createdOn || 'Bonk Launchpad'
        }
      ],
      properties: {
        category: 'token',
        files: [
          {
            uri: imageUrl,
            type: 'image/png'
          }
        ]
      }
    };

    // Upload metadata to Filebase
    const metadataBuffer = Buffer.from(JSON.stringify(metadata, null, 2));
    const metadataUrl = await filebaseService.uploadToFilebase(
      metadataBuffer,
      `metadata/${Date.now()}-${tokenData.symbol.toLowerCase()}.json`,
      'application/json'
    );

    console.log('Metadata uploaded to Filebase:', metadataUrl);
    
    return { 
      uri: metadataUrl, 
      imageUrl 
    };
  } catch (error) {
    console.error('Error in createBonkFunTokenMetadata:', error);
    throw new Error(`Failed to upload to Filebase: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const createBonkTokenTx = async (
  connection: Connection,
  mainKp: Keypair,
  mintKp: Keypair,
  tokenData: LaunchpadRequest
) => {
  try {
    if (!tokenData.name || !tokenData.symbol || !tokenData.image) {
      throw new Error(
        "Missing required fields: name, symbol, and image are required"
      );
    }

    if (tokenData.name.length > 32) {
      throw new Error("Name must be 32 characters or less");
    }

    if (tokenData.symbol.length > 8) {
      throw new Error("Symbol must be 8 characters or less");
    }

    if (tokenData.description && tokenData.description.length > 200) {
      throw new Error("Description must be 200 characters or less");
    }

    const urlPattern = /^(https?:\/\/)/;
    if (tokenData.createdOn && !urlPattern.test(tokenData.createdOn)) {
      throw new Error("createdOn must be a valid URL");
    }
    if (tokenData.website && !urlPattern.test(tokenData.website)) {
      throw new Error("website must be a valid URL");
    }
    if (tokenData.twitter && !urlPattern.test(tokenData.twitter)) {
      throw new Error("twitter must be a valid URL");
    }
    if (tokenData.telegram && !urlPattern.test(tokenData.telegram)) {
      throw new Error("telegram must be a valid URL");
    }

    if (
      tokenData.decimals &&
      (isNaN(tokenData.decimals) ||
        tokenData.decimals < 0 ||
        tokenData.decimals > 9)
    ) {
      throw new Error("Decimals must be a number between 0 and 9");
    }

    if (tokenData.migrateType && !["amm"].includes(tokenData.migrateType)) {
      throw new Error("Invalid migrateType");
    }

    const { uri, imageUrl } = await createBonkFunTokenMetadata(tokenData);
    if (!uri) {
      throw new Error("Token metadata URI is undefined");
    }

    const raydium = await initSdk({ loadToken: true });
    const configId = getPdaLaunchpadConfigId(
      LAUNCHPAD_PROGRAM,
      NATIVE_MINT,
      0,
      0
    ).publicKey;

    const configData = await connection.getAccountInfo(configId);
    if (!configData) {
      throw new Error("Config not found");
    }

    const configInfo = LaunchpadConfig.decode(configData.data);
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

    const slippage = new BN(tokenData.slippage || 100);

    const { transactions } = await raydium.launchpad.createLaunchpad({
      programId: LAUNCHPAD_PROGRAM,
      mintA: mintKp.publicKey,
      decimals: tokenData.decimals || 6,
      name: tokenData.name,
      symbol: tokenData.symbol,
      migrateType: tokenData.migrateType || "amm",
      uri,
      configId,
      configInfo,
      mintBDecimals: mintBInfo.decimals,
      slippage,
      platformId: tokenData.platformId
        ? new PublicKey(tokenData.platformId)
        : BONK_PLATFROM_ID,
      txVersion: TxVersion.LEGACY,
      buyAmount: new BN(1),
      feePayer: mainKp.publicKey,
      createOnly: true,
      extraSigners: [mintKp],
      computeBudgetConfig: {
        units: 1_200_000,
        microLamports: 100_000,
      },
    });

    const ixs = [...transactions[0].instructions];

    // if (tokenData.buyAmount && tokenData.buyAmount > 0) {
    //   const buyInstruction = await makeBuyIx(
    //     mainKp,
    //     tokenData.buyAmount * LAMPORTS_PER_SOL,
    //     mintKp.publicKey
    //   );
    //   ixs.push(...buyInstruction);
    // }

    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([mainKp, mintKp]);

    const sim = await connection.simulateTransaction(transaction, {
      sigVerify: true,
    });

    console.log(
      "create token transaction simulate ==>",
      JSON.stringify(sim, null, 2)
    );

    let signature: string;
    
    try {
      // First try with Helius
      console.log('\n=== Attempting to send transaction via Helius ===');
      signature = await sendWithHelius(transaction);
    } catch (error) {
      console.warn('Helius submission failed, falling back to direct RPC:', error);
      // Fall back to direct RPC submission
      console.log('\n=== Sending transaction via direct RPC ===');
      const txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      console.log('✅ Transaction submitted via RPC:', txid);
      console.log(`🌐 Explorer: https://explorer.solana.com/tx/${txid}`);
      
      // Wait for confirmation
      console.log('\n=== Waiting for Confirmation ===');
      console.log('⏳ Waiting for transaction confirmation...');
      const confirmation = await connection.confirmTransaction(txid, 'confirmed');
      
      console.log('✅ Transaction confirmed in slot:', confirmation.context.slot);
      signature = txid;
    }

    // Store token data in the database
    await storeTokenData({
      tokenMint: mintKp.publicKey.toBase58(),
      tokenName: tokenData.name,
      tokenSymbol: tokenData.symbol,
      creatorAddress: mainKp.publicKey.toBase58(),
      metadataUri: uri,
      imageUri: imageUrl,
      description: tokenData.description || null,
      socialMedia: {
        website: tokenData.website || "https://bonk.fun",
        twitter: tokenData.twitter || "https://x.com/bonkfun",
        telegram: tokenData.telegram || "https://t.me/bonkfun",
      },
      platformId: tokenData.platformId || BONK_PLATFROM_ID.toBase58(),
      configId: configId.toBase58(),
      poolId: getPdaLaunchpadPoolId(
        LAUNCHPAD_PROGRAM,
        mintKp.publicKey,
        NATIVE_MINT
      ).publicKey.toBase58(),
      vaultA: getPdaLaunchpadVaultId(
        LAUNCHPAD_PROGRAM,
        getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintKp.publicKey, NATIVE_MINT)
          .publicKey,
        mintKp.publicKey
      ).publicKey.toBase58(),
      vaultB: getPdaLaunchpadVaultId(
        LAUNCHPAD_PROGRAM,
        getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintKp.publicKey, NATIVE_MINT)
          .publicKey,
        NATIVE_MINT
      ).publicKey.toBase58(),
      signature: "",
      initialBuyAmount: tokenData.buyAmount
        ? tokenData.buyAmount * LAMPORTS_PER_SOL
        : null,
      decimals: tokenData.decimals || 6,
    });

    return transaction;
  } catch (error) {
    console.error("createBonkTokenTx error:", error);
    throw error;
  }
};

const storeTokenData = async (data: {
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  creatorAddress: string;
  metadataUri: string;
  imageUri: string;
  description: string | null;
  socialMedia: { website: string; twitter: string; telegram: string };
  platformId: string;
  configId: string;
  poolId: string;
  vaultA: string;
  vaultB: string;
  signature: string;
  initialBuyAmount: number | null;
  decimals: number;
}) => {
  try {
    const STANDARD_INITIAL_SUPPLY = 1_000_000_000;

    await LaunchlabTokens.create({
      tokenMint: data.tokenMint,
      tokenName: data.tokenName,
      tokenSymbol: data.tokenSymbol,
      creatorAddress: data.creatorAddress,
      metadataUri: data.metadataUri,
      imageUri: data.imageUri || null,
      description: data.description || null,
      socialMedia: data.socialMedia,
      initialMarketCap: null,
      currentMarketCap: null,
      initialSupply: STANDARD_INITIAL_SUPPLY,
      currentSupply: STANDARD_INITIAL_SUPPLY,
      platformId: data.platformId,
      configId: data.configId,
      poolId: data.poolId,
      vaultA: data.vaultA,
      vaultB: data.vaultB,
      signature: data.signature,
      status: "active",
      initialBuyAmount: data.initialBuyAmount,
      decimals: data.decimals,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`Token data stored for mint: ${data.tokenMint}`);
  } catch (error) {
    console.error("Failed to store token data:", error);
    throw new Error(
      `Failed to store token data: ${error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
};

export const updateTokenSignatureLaunchlab = async (
  tokenMint: string,
  signature: string
) => {
  try {
    await LaunchlabTokens.update(
      {
        signature,
      },
      {
        where: {
          tokenMint,
        },
      }
    );

    console.log(
      `creation signature update for toekn ${tokenMint}: ${signature}`
    );
  } catch (error) {
    console.error("Failed to store token data:", error);
    throw new Error(
      `Failed to store token data: ${error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
};
export const makeBuyIx = async (
  kp: Keypair,
  buyAmount: number,
  mintAddress: PublicKey
) => {
  try {
    console.log("\n=== Starting makeBuyIx ===");
    console.log("Buyer Public Key:", kp.publicKey.toString());
    console.log("Buy Amount (lamports):", buyAmount);
    console.log("Mint Address:", mintAddress.toString());

    // Add validation for buyAmount
    if (buyAmount <= 0) {
      throw new Error(`Invalid buy amount: ${buyAmount}. Must be greater than 0`);
    }
    if (buyAmount < LAMPORTS_PER_SOL * 0.01) { // Minimum 0.01 SOL
      throw new Error(`Buy amount too small: ${buyAmount}. Minimum is ${LAMPORTS_PER_SOL * 0.01} lamports (0.01 SOL)`);
    }

    const buyInstruction: TransactionInstruction[] = [];
    const lamports = buyAmount;

    console.log("\n=== Program and Configuration ===");
    const programId = LAUNCHPAD_PROGRAM;
    console.log("Launchpad Program ID:", programId.toString());

    const configId = getPdaLaunchpadConfigId(
      programId,
      NATIVE_MINT,
      0,
      0
    ).publicKey;
    console.log("Config ID:", configId.toString());

    const poolId = getPdaLaunchpadPoolId(
      programId,
      mintAddress,
      NATIVE_MINT
    ).publicKey;
    console.log("Pool ID:", poolId.toString());

    console.log("\n=== Token Accounts ===");
    const userTokenAccountA = getAssociatedTokenAddressSync(
      mintAddress,
      kp.publicKey
    );
    console.log("User Token Account A (mint):", userTokenAccountA.toString());

    const userTokenAccountB = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      kp.publicKey
    );
    console.log("User Token Account B (WSOL):", userTokenAccountB.toString());

    console.log("\n=== Balance and Rent ===");
    const rentExemptionAmount = await connection.getMinimumBalanceForRentExemption(165);
    console.log("Rent Exemption Amount:", rentExemptionAmount);

    const buyerBalance = await connection.getBalance(kp.publicKey);
    console.log("Buyer SOL Balance (lamports):", buyerBalance);
    console.log("Buyer SOL Balance (SOL):", buyerBalance / LAMPORTS_PER_SOL);

    const requiredBalance = rentExemptionAmount * 2 + lamports;
    console.log("Required Balance (lamports):", requiredBalance);
    console.log("Required Balance (SOL):", requiredBalance / LAMPORTS_PER_SOL);
    console.log("Sufficient Balance:", buyerBalance >= requiredBalance ? "✅" : "❌");

    if (buyerBalance < requiredBalance) {
      throw new Error(`Insufficient balance. Need ${requiredBalance} lamports (${requiredBalance / LAMPORTS_PER_SOL} SOL), but only have ${buyerBalance} lamports (${buyerBalance / LAMPORTS_PER_SOL} SOL)`);
    }

    console.log("\n=== Vaults and ATAs ===");
    const vaultA = getPdaLaunchpadVaultId(
      programId,
      poolId,
      mintAddress
    ).publicKey;
    console.log("Vault A (mint):", vaultA.toString());

    const vaultB = getPdaLaunchpadVaultId(
      programId,
      poolId,
      NATIVE_MINT
    ).publicKey;
    console.log("Vault B (WSOL):", vaultB.toString());

    const shareATA = getATAAddress(kp.publicKey, NATIVE_MINT).publicKey;
    console.log("Share ATA:", shareATA.toString());

    const authProgramId = getPdaLaunchpadAuth(programId).publicKey;
    console.log("Auth Program ID:", authProgramId.toString());

    // Increased minmintAmount from 1000 to 1,000,000,000 (1 token with 9 decimals)
    const minmintAmount = new BN(1000000000);
    console.log("Minimum Mint Amount:", minmintAmount.toString());

    // Rest of the function remains the same...
    console.log("\n=== Creating Token ATAs ===");
    const tokenAta = await getAssociatedTokenAddress(mintAddress, kp.publicKey);
    console.log("Token ATA:", tokenAta.toString());

    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
    console.log("WSOL ATA:", wsolAta.toString());

    console.log("\n=== Building Instructions ===");
    // Create token accounts if they don't exist
    const createTokenAccountIx = createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey,
      tokenAta,
      kp.publicKey,
      mintAddress
    );
    console.log("Created Create Token Account Instruction");

    const createWsolAccountIx = createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey,
      wsolAta,
      kp.publicKey,
      NATIVE_MINT
    );
    console.log("Created Create WSOL Account Instruction");

    const transferIx = SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: wsolAta,
      lamports,
    });
    console.log(`Created Transfer Instruction: ${lamports} lamports to WSOL ATA`);

    const syncNativeIx = createSyncNativeInstruction(wsolAta);
    console.log("Created Sync Native Instruction");

    buyInstruction.push(
      createTokenAccountIx,
      createWsolAccountIx,
      transferIx,
      syncNativeIx
    );

    console.log("\n=== Creating Buy Exact In Instruction ===");
    const inputParams = {
      programId: programId.toString(),
      payer: kp.publicKey.toString(),
      authProgramId: authProgramId.toString(),
      configId: configId.toString(),
      platformId: BONK_PLATFROM_ID.toString(),
      poolId: poolId.toString(),
      userTokenAccountA: userTokenAccountA.toString(),
      userTokenAccountB: userTokenAccountB.toString(),
      vaultA: vaultA.toString(),
      vaultB: vaultB.toString(),
      mintAddress: mintAddress.toString(),
      nativeMint: NATIVE_MINT.toString(),
      tokenProgramId: TOKEN_PROGRAM_ID.toString(),
      lamports,
      minmintAmount: minmintAmount.toString(),
      shareATA: shareATA.toString()
    };
    console.log("Input parameters:", JSON.stringify(inputParams, null, 2));

    // Fetch the associated token program ID
    const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

    const instruction = buyExactInInstruction(
      programId,                      // programId
      kp.publicKey,                   // payer
      authProgramId,                  // authProgramId
      configId,                       // configId
      BONK_PLATFROM_ID,               // platformId
      poolId,                         // poolId
      userTokenAccountA,              // userTokenAccountA
      userTokenAccountB,              // userTokenAccountB
      vaultA,                         // vaultA
      vaultB,                         // vaultB
      mintAddress,                    // mintA
      NATIVE_MINT,                    // mintB (native mint)
      TOKEN_PROGRAM_ID,               // tokenProgramId - Standard token program
      ASSOCIATED_TOKEN_PROGRAM_ID,    // associatedTokenProgramId - NOT TOKEN_PROGRAM_ID again!
      kp.publicKey,                   // userTransferAuthority
      kp.publicKey,                   // userShareAuthority
      new BN(lamports),               // buyAmount
      minmintAmount,                  // minMintAmount
      new BN(500),                    // slippageTolerance (500 = 5%)
      shareATA                        // shareATA
    );

    console.log("\n=== Buy Exact In Instruction Created ===");
    console.log("Instruction Program ID:", instruction.programId.toString());
    console.log("Instruction Keys:", instruction.keys.map((k, i) =>
      `${i}: ${k.pubkey.toString()} (signer: ${k.isSigner}, writable: ${k.isWritable})`
    ));

    buyInstruction.push(instruction);
    console.log("\n=== Final Instructions ===");
    buyInstruction.forEach((ix, i) => {
      console.log(`Instruction ${i}: ${ix.programId.toString()}`);
    });

    console.log("\n=== makeBuyIx Completed Successfully ===\n");
    return buyInstruction;
  } catch (error) {
    console.error("\n!!! Error in makeBuyIx !!!");
    console.error("Error details:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Stack trace:", error.stack);
    }
    throw error;
  }
};
