import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { utils, web3 } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { JitoBundler } from "../jito/jitoService";
import dotenv from "dotenv";
import { FilebaseService } from "../filebase";
import PumpfunTokens from "../db/models/pumpfun.tokens";
import axios from "axios";

dotenv.config();

const defaultDecimal = 6;

// Define the TokenCreationRequest interface
interface TokenCreationRequest {
  name: string;
  symbol: string;
  creatorKeypair: string;
  uri?: string;
  imageBuffer?: Buffer;
  external_url?: string;
  buyAmount?: number;
  description?: string; // Optional description
  extensions?: { [key: string]: string } | null; // Optional social media links
  mayhemMode?: boolean; // Enable mayhem mode for this token
}

export class TokenService {
  private readonly connection: Connection;
  private readonly jitoBundler: JitoBundler;
  private readonly programId: PublicKey = new PublicKey(
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  );
  private readonly filebaseService: FilebaseService;
  private readonly sequelize: any; // Sequelize instance
  private readonly heliusApiKey: string;
  private readonly heliusSenderEndpoint: string;
  private readonly SEEDS = {
    MINT_AUTHORITY: utils.bytes.utf8.encode("mint-authority"),
    BONDING_CURVE: utils.bytes.utf8.encode("bonding-curve"),
    GLOBAL: utils.bytes.utf8.encode("global"),
    EVENT_AUTHORITY: utils.bytes.utf8.encode("__event_authority"),
    ASSOCIATED_BONDING_CURVE_CONSTANT: Buffer.from([
      6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121,
      172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0,
      169,
    ]),
    METADATA_CONSTANT: Buffer.from([
      11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205,
      88, 184, 108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
    ]),
    CREATOR_VAULT: utils.bytes.utf8.encode("creator-vault"),
  };

  constructor() {
    this.heliusApiKey = process.env.HELIUS_API_KEY || '13c26701-a23a-450a-9d26-382ab32eaf1f';
    if (!this.heliusApiKey) {
      console.warn('HELIUS_API_KEY is not set. Using default RPC endpoint.');
    }

    const rpcUrl = this.heliusApiKey
      ? `https://devnet.helius-rpc.com/?api-key=${this.heliusApiKey}`
      : process.env.RPC_URL || "https://api.devnet.solana.com";

    this.connection = new Connection(rpcUrl, "confirmed");
    this.jitoBundler = new JitoBundler("1000000", this.connection);
    this.filebaseService = new FilebaseService();
    this.sequelize = require("../db/database").sequelize; // Assuming sequelize is exported from database.ts

    // Use regional HTTP endpoint closest to your servers for better performance
    this.heliusSenderEndpoint = this.heliusApiKey
      ? 'https://devnet.helius-rpc.com/'
      : 'https://api.devnet.solana.com';
  }

  async createPumpFunToken(req: TokenCreationRequest) {
    try {
      this.validateRequest(req);
      const creatorKeypair = this.getCreatorKeypair(req.creatorKeypair);
      const { tokenMint, bondingCurve, associatedBondingCurve } =
        await this.findAvailableAccounts();

      console.log('Found available accounts:', {
        tokenMint: tokenMint.publicKey.toBase58(),
        bondingCurve: bondingCurve.toBase58(),
        associatedBondingCurve: associatedBondingCurve.toBase58()
      });

      // Upload metadata first
      const { uri, imageUrl } = await this.filebaseService.uploadMetadata(req);
      console.log('Uploaded metadata:', { uri, imageUrl });

      const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
      console.log('Latest blockhash:', latestBlockhash.blockhash);

      // Create the main token creation instruction
      const pumpFunInstruction = await this.createPumpFunInstruction(
        tokenMint.publicKey,
        creatorKeypair,
        { ...req, uri }
      );

      const transaction = new Transaction().add(pumpFunInstruction);
      transaction.feePayer = creatorKeypair.publicKey;
      transaction.recentBlockhash = latestBlockhash.blockhash;

      // If buyAmount is specified, add the buy operation
      // if (req.buyAmount && req.buyAmount > 0) {
      //   console.log('Adding buy operation with amount:', req.buyAmount);

      //   const associatedUser = await web3.PublicKey.findProgramAddress(
      //     [
      //       creatorKeypair.publicKey.toBuffer(),
      //       TOKEN_PROGRAM_ID.toBuffer(),
      //       tokenMint.publicKey.toBuffer(),
      //     ],
      //     ASSOCIATED_TOKEN_PROGRAM_ID
      //   );

      //   console.log('Associated user token account:', associatedUser[0].toBase58());

      //   const createATAInstruction = createAssociatedTokenAccountInstruction(
      //     creatorKeypair.publicKey,
      //     associatedUser[0],
      //     creatorKeypair.publicKey,
      //     tokenMint.publicKey
      //   );

      //   transaction.add(createATAInstruction);

      //   const buyInstruction = await this.createBuyInstruction(
      //     tokenMint.publicKey,
      //     creatorKeypair.publicKey,
      //     bondingCurve,
      //     associatedBondingCurve,
      //     associatedUser[0],
      //     req.buyAmount
      //   );

      //   transaction.add(buyInstruction);
      // }

      // Sign the transaction
      transaction.sign(tokenMint, creatorKeypair);

      // Simulate the transaction first
      console.log('Simulating transaction...');
      const simulation = await this.connection.simulateTransaction(transaction);
      if (simulation.value.err) {
        console.error('Transaction simulation failed:', simulation.value.logs);
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      console.log('Transaction simulation successful. Submitting transaction via Helius Sender...');

      let signature: string;
      try {
        // Use Helius Sender for transaction submission
        signature = await this.sendWithHelius(transaction, [tokenMint, creatorKeypair]);
        console.log('Transaction submitted via Helius Sender, signature:', signature);

        // Get the latest blockhash for confirmation
        const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

        // Confirm the transaction
        const confirmation = await this.connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }, 'confirmed');

        console.log('Transaction confirmed:', confirmation);

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
      } catch (error) {
        console.error('Error submitting transaction via Helius Sender, falling back to standard RPC...', error);
        // Fallback to standard RPC if Helius Sender fails
        signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });
        console.log('Transaction submitted via standard RPC, signature:', signature);

        // Get the latest blockhash for confirmation
        const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

        // Confirm the transaction
        const confirmation = await this.connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }, 'confirmed');

        console.log('Transaction confirmed via standard RPC:', confirmation);

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
      }

      // Store token data in the database
      const tokenData = {
        ...req,
        extensions: req.extensions || null,
        name: req.name,
        symbol: req.symbol,
        creatorKeypair: req.creatorKeypair,
        buyAmount: req.buyAmount,
        tokenMint: tokenMint.publicKey.toBase58(),
        image: imageUrl,
        description: req.description || null,
        bondingCurveAddress: bondingCurve.toBase58(),
        associatedBondingCurveAddress: associatedBondingCurve.toBase58(),
        signature,
        uri,
      };

      console.log('Token data stored successfully');

      return {
        success: true,
        signature,
        mintAddress: tokenMint.publicKey.toBase58(),
        message: 'Token created and bought successfully'
      };

    } catch (error) {
      console.error('Error in createPumpFunToken:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async sendWithHelius(transaction: Transaction, signers: Keypair[] = []): Promise<string> {
    try {
      console.log('\n=== Transaction Signing Started ===');
      console.log(`Signing with ${signers.length} signers...`);

      // Sign the transaction with all required signers
      transaction.sign(...signers);
      console.log('✅ Transaction signed successfully');

      // Serialize the transaction
      const serializedTx = transaction.serialize();
      const base64Tx = serializedTx.toString('base64');
      console.log(`📄 Transaction serialized (${base64Tx.length} bytes)`);

      console.log('\n=== Sending Transaction via Helius ===');
      console.log(`🌐 Endpoint: ${this.heliusSenderEndpoint}`);
      console.log('📤 Sending transaction data...');

      const startTime = Date.now();
      const response = await axios.post(
        this.heliusSenderEndpoint,
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
            'Authorization': `Bearer ${this.heliusApiKey}`
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
      console.log(`🌐 Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

      console.log('\n=== Waiting for Confirmation ===');
      console.log('⏳ Waiting for transaction confirmation...');
      const confirmStartTime = Date.now();

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(
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

  private async storeTokenData(data: {
    name: string;
    symbol: string;
    creatorKeypair: string;
    buyAmount?: number;
    tokenMint: string;
    uri: string;
    image: string | undefined;
    description: string | null;
    bondingCurveAddress: string;
    associatedBondingCurveAddress: string;
    signature: string;
    extensions: { [key: string]: string } | null;
    mayhemMode?: boolean;
  }) {
    try {
      const STANDARD_INITIAL_SUPPLY = 1_000_000_000;

      // Convert buyAmount to an integer, truncating any decimals
      const buyAmountNum = data.buyAmount ? Number(data.buyAmount) : null;
      if (buyAmountNum !== null && !Number.isFinite(buyAmountNum)) {
        throw new Error(
          `buyAmount must be a valid number, got ${data.buyAmount}`
        );
      }
      const initialBuyAmount =
        buyAmountNum !== null ? Math.floor(buyAmountNum) : null;

      await PumpfunTokens.create({
        tokenMint: data.tokenMint,
        tokenName: data.name,
        tokenSymbol: data.symbol,
        creatorAddress: this.getCreatorKeypair(
          data.creatorKeypair
        ).publicKey.toBase58(),
        metadataUri: data.uri,
        imageUri: data.image || null,
        description: data.description || null,
        socialMedia: data.extensions || null,
        initialMarketCap: null, // Not available
        currentMarketCap: null, // Not available
        initialSupply: STANDARD_INITIAL_SUPPLY, // Use standard value
        currentSupply: STANDARD_INITIAL_SUPPLY, // Initially same as initialSupply
        bondingCurveAddress: data.bondingCurveAddress,
        associatedBondingCurveAddress: data.associatedBondingCurveAddress,
        signature: data.signature,
        status: "bonding", // Default status
        initialBuyAmount,
        mayhemMode: data.mayhemMode || false,
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
  }

  private async updateTokenSignaturePumpfun(
    tokenMint: string,
    signature: string
  ) {
    try {
      await PumpfunTokens.update(
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
  }

  private validateRequest(req: TokenCreationRequest): void {
    if (
      !req.name ||
      !req.symbol ||
      !req.creatorKeypair ||
      (!req.uri && !req.imageBuffer)
    ) {
      throw new Error(
        "Missing required fields: name, symbol, creatorKeypair, and either uri or image file"
      );
    }

    if (req.name.length > 32) {
      throw new Error("Name must be 32 characters or less");
    }

    if (req.symbol.length > 8) {
      throw new Error("Symbol must be 8 characters or less");
    }

    if (req.uri && req.uri.length > 200) {
      throw new Error("URI must be 200 characters or less");
    }

    if (req.imageBuffer && req.imageBuffer.length > 100_000_000) {
      throw new Error("Image file must be less than 100MB for Filebase");
    }

    if (req.external_url && !/^(https?:\/\/)/.test(req.external_url)) {
      throw new Error("external_url must be a valid URL");
    }

    if (req.buyAmount && (req.buyAmount <= 0 || isNaN(req.buyAmount))) {
      throw new Error("buyAmount must be a positive number in lamports");
    }

    if (req.buyAmount && req.buyAmount > Number.MAX_SAFE_INTEGER) {
      throw new Error("buyAmount is too large");
    }
  }

  private getCreatorKeypair(secretKeyBase58: string): Keypair {
    const secretKey = bs58.decode(secretKeyBase58);
    if (secretKey.length !== 64) {
      throw new Error("Invalid creatorKeypair: must be 64 bytes");
    }
    return Keypair.fromSecretKey(secretKey);
  }

  private async findAvailableAccounts(): Promise<{
    tokenMint: Keypair;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    metadata: PublicKey;
  }> {
    const maxAttempts = 20;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      const tokenMint = Keypair.generate();
      const bondingCurve = web3.PublicKey.findProgramAddressSync(
        [this.SEEDS.BONDING_CURVE, tokenMint.publicKey.toBuffer()],
        this.programId
      )[0];
      const associatedBondingCurve = web3.PublicKey.findProgramAddressSync(
        [
          bondingCurve.toBuffer(),
          this.SEEDS.ASSOCIATED_BONDING_CURVE_CONSTANT,
          tokenMint.publicKey.toBuffer(),
        ],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      )[0];
      const metadata = web3.PublicKey.findProgramAddressSync(
        [
          utils.bytes.utf8.encode("metadata"),
          this.SEEDS.METADATA_CONSTANT,
          tokenMint.publicKey.toBuffer(),
        ],
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
      )[0];

      const [
        mintAccountInfo,
        bondingCurveInfo,
        associatedBondingCurveInfo,
        metadataInfo,
      ] = await Promise.all([
        this.connection.getAccountInfo(tokenMint.publicKey),
        this.connection.getAccountInfo(bondingCurve),
        this.connection.getAccountInfo(associatedBondingCurve),
        this.connection.getAccountInfo(metadata),
      ]);

      if (
        !mintAccountInfo &&
        !bondingCurveInfo &&
        !associatedBondingCurveInfo &&
        !metadataInfo
      ) {
        return { tokenMint, bondingCurve, associatedBondingCurve, metadata };
      }
    }
    throw new Error(
      "Failed to find unused mint, bonding curve, or metadata accounts after maximum attempts"
    );
  }

  private async simulateTransaction(transaction: Transaction): Promise<void> {
    const simulationResult = await this.connection.simulateTransaction(
      transaction
    );
    console.log(
      "Simulation Result:",
      JSON.stringify(simulationResult, null, 2)
    );
    if (simulationResult.value.err) {
      throw new Error(
        `Transaction simulation failed: ${JSON.stringify(
          simulationResult.value.err
        )}`
      );
    }
  }

  private async submitTransaction(
    transaction: Transaction,
    creatorKeypair: Keypair,
    latestBlockhash: { blockhash: string; lastValidBlockHeight: number },
    tokenMint: Keypair
  ) {
    let result: { confirmed: boolean; signature?: string; error?: string };
    try {
      console.log("Attempting Jito bundler submission...");
      result = await this.jitoBundler.executeAndConfirm(
        transaction,
        creatorKeypair,
        latestBlockhash,
        [tokenMint]
      );
      if (result.confirmed) {
        if (result.signature) {
          await this.updateTokenSignaturePumpfun(
            tokenMint.publicKey.toBase58(),
            result.signature
          );
        }
        console.log("Jito Transaction Signature:", result.signature);
      } else {
        console.log("Jito bundler failed:", result.error);
      }
    } catch (jitoError) {
      console.error("Jito Bundler Error:", JSON.stringify(jitoError, null, 2));
      result = {
        confirmed: false,
        error:
          jitoError instanceof Error
            ? jitoError.message
            : "Jito bundler failed",
      };
    }

    if (!result.confirmed) {
      result = await this.fallbackDirectSubmission(
        transaction,
        creatorKeypair,
        latestBlockhash,
        tokenMint
      );
    }

    return {
      success: result.confirmed,
      signature: result.signature,
      mintAddress: tokenMint.publicKey.toBase58(),
      error: result.error,
    };
  }

  private async fallbackDirectSubmission(
    transaction: Transaction,
    creatorKeypair: Keypair,
    latestBlockhash: { blockhash: string; lastValidBlockHeight: number },
    tokenMint: Keypair
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    const maxRetries = 3;
    let result: { confirmed: boolean; signature?: string; error?: string } = {
      confirmed: false,
      error: "Direct submission failed",
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Direct submission attempt ${attempt}/${maxRetries}...`);
        if (attempt > 1) {
          const newBlockhash = await this.connection.getLatestBlockhash(
            "confirmed"
          );
          transaction.recentBlockhash = newBlockhash.blockhash;
          transaction.sign(tokenMint, creatorKeypair);
        }
        const signature = await this.connection.sendRawTransaction(
          transaction.serialize()
        );
        console.log("Direct Transaction Signature:", signature);
        const confirmation = await this.connection.confirmTransaction(
          {
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          "confirmed"
        );
        console.log(
          "Direct Confirmation:",
          JSON.stringify(confirmation, null, 2)
        );
        if (!confirmation.value.err) {
          return { confirmed: true, signature, error: undefined };
        } else {
          result = {
            confirmed: false,
            signature,
            error: `Direct submission failed: ${JSON.stringify(
              confirmation.value.err
            )}`,
          };
        }
      } catch (directError) {
        console.error(
          `Direct submission attempt ${attempt} failed:`,
          directError
        );
        result = {
          confirmed: false,
          signature: result.signature,
          error:
            directError instanceof Error
              ? directError.message
              : "Unknown error",
        };
      }
    }
    return result;
  }

  private async createPumpFunInstruction(
    tokenMint: PublicKey,
    creatorKeypair: Keypair,
    req: TokenCreationRequest
  ): Promise<TransactionInstruction> {
    // Derive PDAs
    const [mintAuthority] = await PublicKey.findProgramAddress(
      [this.SEEDS.MINT_AUTHORITY],
      this.programId
    );

    const [bondingCurve] = await PublicKey.findProgramAddress(
      [this.SEEDS.BONDING_CURVE, tokenMint.toBuffer()],
      this.programId
    );

    const [global] = await PublicKey.findProgramAddress(
      [this.SEEDS.GLOBAL],
      this.programId
    );

    // Mayhem mode program ID
    const mayhemProgramId = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');

    // Find mayhem state PDA
    const [mayhemState] = await PublicKey.findProgramAddress(
      [Buffer.from('mayhem-state'), tokenMint.toBuffer()],
      mayhemProgramId
    );

    // Find global params PDA
    const [globalParams] = await PublicKey.findProgramAddress(
      [Buffer.from('global-params')],
      mayhemProgramId
    );

    // Find SOL vault PDA
    const [solVault] = await PublicKey.findProgramAddress(
      [Buffer.from('sol-vault')],
      mayhemProgramId
    );

    // Token program ID for SPL Token 2022
    const tokenProgramId = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const associatedTokenProgramId = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    // Find mayhem token vault PDA
    const [mayhemTokenVault] = await PublicKey.findProgramAddress(
      [solVault.toBuffer(), tokenProgramId.toBuffer(), tokenMint.toBuffer()],
      associatedTokenProgramId
    );

    // Find associated token account for the bonding curve
    const [associatedBondingCurve] = await PublicKey.findProgramAddress(
      [bondingCurve.toBuffer(), tokenProgramId.toBuffer(), tokenMint.toBuffer()],
      associatedTokenProgramId
    );

    // Find event authority
    const [eventAuthority] = await PublicKey.findProgramAddress(
      [this.SEEDS.EVENT_AUTHORITY],
      this.programId
    );

    // Create the instruction accounts - ordered exactly as in IDL
    const keys = [
      { pubkey: tokenMint, isSigner: true, isWritable: true },          // 0. [signer] The mint account
      { pubkey: mintAuthority, isSigner: false, isWritable: false },    // 1. [] The mint authority
      { pubkey: bondingCurve, isSigner: false, isWritable: true },      // 2. [writable] The bonding curve
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 3. [writable] Associated token account
      { pubkey: global, isSigner: false, isWritable: false },           // 4. [] The global account
      { pubkey: creatorKeypair.publicKey, isSigner: true, isWritable: true }, // 5. [signer, writable] Creator
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 6. [] System program
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },   // 7. [] Token program (SPL Token 2022)
      { pubkey: associatedTokenProgramId, isSigner: false, isWritable: false }, // 8. [] Associated token program
      { pubkey: mayhemProgramId, isSigner: false, isWritable: true },   // 9. [writable] Mayhem program
      { pubkey: globalParams, isSigner: false, isWritable: false },     // 10. [] Global params
      { pubkey: solVault, isSigner: false, isWritable: true },          // 11. [writable] SOL vault
      { pubkey: mayhemState, isSigner: false, isWritable: true },       // 12. [writable] Mayhem state
      { pubkey: mayhemTokenVault, isSigner: false, isWritable: true },  // 13. [writable] Mayhem token vault
      { pubkey: eventAuthority, isSigner: false, isWritable: false },   // 14. [] Event authority
      { pubkey: this.programId, isSigner: false, isWritable: false }    // 15. [] Program ID
    ];

    // Calculate buffer size
    const nameLength = req.name.length;
    const symbolLength = req.symbol.length;
    const uri = req.uri || '';
    const uriLength = uri.length;

    // Calculate total size needed:
    // 8 bytes discriminator + 
    // 4 (name len) + name + 
    // 4 (symbol len) + symbol + 
    // 4 (uri len) + uri + 
    // 32 (creator pubkey) + 
    // 1 (mayhem mode)
    const bufferSize = 8 + 4 + nameLength + 4 + symbolLength + 4 + uriLength + 32 + 1;

    // Create buffer with exact size
    const data = Buffer.alloc(bufferSize);
    let offset = 0;

    // Add discriminator for create_v2 (8 bytes) - Using the correct discriminator from IDL
    const discriminator = [214, 144, 76, 236, 95, 139, 49, 180];
    for (let i = 0; i < discriminator.length; i++) {
      data.writeUInt8(discriminator[i], offset++);
    }

    // Add name (4 bytes length + string)
    data.writeUInt32LE(nameLength, offset);
    offset += 4;
    data.write(req.name, offset, 'utf8');
    offset += nameLength;

    // Add symbol (4 bytes length + string)
    data.writeUInt32LE(symbolLength, offset);
    offset += 4;
    data.write(req.symbol, offset, 'utf8');
    offset += symbolLength;

    // Add URI (4 bytes length + string)
    data.writeUInt32LE(uriLength, offset);
    offset += 4;
    data.write(uri, offset, 'utf8');
    offset += uriLength;

    // Add creator pubkey (32 bytes) - using the creator keypair's public key
    data.write(creatorKeypair.publicKey.toBuffer().toString('hex'), offset, 'hex');
    offset += 32;

    // Add mayhem mode (1 byte) - default to false if not specified
    const mayhemMode = req.mayhemMode || false;
    data.writeUInt8(mayhemMode ? 1 : 0, offset);
    offset += 1;

    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    });
  }

  private async createBuyInstruction(
    mint: PublicKey,
    user: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    associatedUser: PublicKey,
    buyAmount: number
  ): Promise<TransactionInstruction> {
    try {
      console.log('Creating buy instruction with params:', {
        mint: mint.toBase58(),
        user: user.toBase58(),
        bondingCurve: bondingCurve.toBase58(),
        associatedBondingCurve: associatedBondingCurve.toBase58(),
        associatedUser: associatedUser.toBase58(),
        buyAmount
      });

      // 1. Find all required PDAs
      const [global] = web3.PublicKey.findProgramAddressSync(
        [this.SEEDS.GLOBAL],
        this.programId
      );

      const [eventAuthority] = web3.PublicKey.findProgramAddressSync(
        [this.SEEDS.EVENT_AUTHORITY],
        this.programId
      );

      // Add volume accumulator PDAs
      const [globalVolumeAccumulator] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        this.programId
      );

      const [userVolumeAccumulator] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), user.toBuffer()],
        this.programId
      );

      // 2. Get fee recipient (using the same as in createPumpFunInstruction)
      const feeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");

      // 3. Prepare the instruction data
      const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(BigInt(Math.floor(buyAmount * 1e9))); // Convert SOL to lamports

      // Add 10% slippage for maxSolCost
      const maxSolCost = Math.floor(buyAmount * 1.1 * 1e9);
      const maxSolCostBuffer = Buffer.alloc(8);
      maxSolCostBuffer.writeBigUInt64LE(BigInt(maxSolCost));

      const data = Buffer.concat([
        discriminator,
        amountBuffer,
        maxSolCostBuffer
      ]);

      // 4. Prepare all required accounts
      const accounts = [
        { pubkey: global, isSigner: false, isWritable: false }, // global
        { pubkey: feeRecipient, isSigner: false, isWritable: true }, // fee_recipient
        { pubkey: mint, isSigner: false, isWritable: false }, // mint
        { pubkey: bondingCurve, isSigner: false, isWritable: true }, // bonding_curve
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // associated_bonding_curve
        { pubkey: associatedUser, isSigner: false, isWritable: true }, // associated_user
        { pubkey: user, isSigner: true, isWritable: true }, // user
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
        { pubkey: eventAuthority, isSigner: false, isWritable: false }, // event_authority
        { pubkey: this.programId, isSigner: false, isWritable: false }, // program
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true }, // global_volume_accumulator
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }, // user_volume_accumulator
      ];

      console.log('Buy instruction accounts:', accounts.map(a => ({
        pubkey: a.pubkey.toBase58(),
        isSigner: a.isSigner,
        isWritable: a.isWritable
      })));

      return new TransactionInstruction({
        programId: this.programId,
        keys: accounts,
        data
      });
    } catch (error) {
      console.error('Error in createBuyInstruction:', error);
      throw new Error(`Failed to create buy instruction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
