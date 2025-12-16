import { Readable } from 'stream';
import FormData from 'form-data';
import axios from 'axios';
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export class PinataService {
  private readonly pinataJwt: string;
  private readonly pinataGateway: string;
  private readonly axiosInstance;

  constructor() {
    this.pinataJwt = process.env.PINATA_JWT || '';
    this.pinataGateway = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

    if (!this.pinataJwt) {
      throw new Error("PINATA_JWT is required in .env");
    }

    this.axiosInstance = axios.create({
      baseURL: 'https://api.pinata.cloud',
      headers: {
        'Authorization': `Bearer ${this.pinataJwt}`
      }
    });
  }

  private getCreatorKeypair(secretKeyBase58: string): Keypair {
    const secretKey = bs58.decode(secretKeyBase58);
    if (secretKey.length !== 64) {
      throw new Error("Invalid creatorKeypair: must be 64 bytes");
    }
    return Keypair.fromSecretKey(secretKey);
  }

  private async pinToIPFS(data: any, isJson: boolean = false): Promise<{ IpfsHash: string }> {
    try {
      const url = isJson
        ? '/pinning/pinJSONToIPFS'
        : '/pinning/pinFileToIPFS';

      const config = isJson
        ? { 
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.pinataJwt}`
            } 
          }
        : { 
            headers: {
              ...data.getHeaders(),
              'Authorization': `Bearer ${this.pinataJwt}`
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          };

      const requestData = isJson ? data : data;
      const response = await axios.post(
        `https://api.pinata.cloud${url}`,
        requestData,
        config
      );
      return response.data;
    } catch (error: any) {
      console.error('Pinata upload error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.details || 'Failed to upload to Pinata');
    }
  }

  async uploadMetadata(req: any): Promise<{ uri: string; imageUrl: string }> {
    if (!req.imageBuffer || !req.imageFileName) {
      throw new Error("Image buffer and filename are required for metadata upload");
    }

    try {
      // Upload image
      const formData = new FormData();
      const stream = Readable.from(req.imageBuffer);
      formData.append('file', stream, {
        filename: req.imageFileName,
        contentType: 'image/jpeg'
      });
      formData.append('pinataMetadata', JSON.stringify({
        name: req.imageFileName,
        keyvalues: { type: 'token-image' }
      }));

      const imageUpload = await this.pinToIPFS(formData);
      const imageUrl = `${this.pinataGateway}/${imageUpload.IpfsHash}`;
      console.log("Image uploaded successfully. IPFS Hash:", imageUpload.IpfsHash);

      // Prepare and upload metadata
      const creatorKeypair = req.owner || this.getCreatorKeypair(req.creatorKeypair);

      const metadata = {
        name: req.name?.slice(0, 32) || 'Unnamed Token',
        symbol: req.symbol?.slice(0, 8) || 'TOKEN',
        description: req.description || "A Pump.fun token",
        image: imageUrl,
        external_url: req.external_url || "",
        attributes: req.attributes || [],
        properties: {
          files: [{ uri: imageUrl, type: "image/jpeg" }],
          category: "image",
          creators: [{
            address: req.owner || creatorKeypair.publicKey.toBase58(),
            share: 100,
          }],
        },
        seller_fee_basis_points: 0,
      };

      const metadataUpload = await this.pinToIPFS({
        pinataMetadata: {
          name: `${req.name || 'token'}-metadata.json`,
          keyvalues: { type: 'token-metadata' }
        },
        pinataContent: metadata
      }, true);

      const uri = `${this.pinataGateway}/${metadataUpload.IpfsHash}`;
      console.log("Metadata uploaded successfully. IPFS Hash:", metadataUpload.IpfsHash);

      return { uri, imageUrl };

    } catch (error: any) {
      console.error('Error in uploadMetadata:', error);
      throw new Error(`Failed to upload metadata: ${error.message}`);
    }
  }
}