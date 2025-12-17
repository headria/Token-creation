import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandOutput,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

// Define a custom interface for the response metadata structure exposed by Filebase.
interface FilebaseResponseMetadata {
  httpStatusCode?: number;
  requestId?: string;
  extendedRequestId?: string;
  cfId?: string;
  attempts: number;
  totalRetryDelay: number;
  // We keep this here to satisfy the PutObjectCommandOutput extension
  httpHeaders?: Record<string, string>;
}

// Extend the PutObjectCommandOutput
declare module '@aws-sdk/client-s3' {
  interface PutObjectCommandOutput {
    $metadata: FilebaseResponseMetadata;
  }
}

export class FilebaseService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly filebaseGateway: string;

  constructor() {
    const accessKeyId = process.env.FILEBASE_API_KEY || '';
    const secretAccessKey = process.env.FILEBASE_API_SECRET || '';
    this.bucketName = process.env.FILEBASE_BUCKET_NAME || 'pumpfun';
    this.filebaseGateway = 'https://agricultural-gray-ocelot.myfilebase.com/ipfs';

    if (!accessKeyId || !secretAccessKey) {
      throw new Error("FILEBASE_API_KEY and FILEBASE_API_SECRET are required in .env");
    }

    this.s3Client = new S3Client({
      endpoint: 'https://s3.filebase.com',
      region: 'us-east-1',
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  public async uploadToFilebase(content: Buffer, filename: string, contentType: string): Promise<string> {
    try {
      const fileExt = filename.split('.').pop() || '';
      const key = `file-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

      console.log('Uploading to Filebase S3:', {
        bucket: this.bucketName,
        key,
        contentType,
        size: content.length
      });

      // 1. Execute the PutObjectCommand (Upload)
      const uploadCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: content,
        ContentType: contentType,
        Metadata: {
          'filename': filename,
          'ipfs-pin': 'true' // CRITICAL: This ensures a CID is generated and pinned.
        }
      });

      const response = await this.s3Client.send(uploadCommand);

      if (!response.ETag) {
        throw new Error('Invalid response from Filebase S3: Missing ETag');
      }

      console.log(`File uploaded. ETag: ${response.ETag}. Now fetching metadata for CID with HeadObject...`);

      // 2. Execute the HeadObjectCommand (Fetch CID)
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const headResponse = await this.s3Client.send(headCommand);

      // FIX: Rely primarily on the S3 SDK's 'Metadata' property, 
      // where Filebase and AWS traditionally map x-amz-meta-headers.
      const ipfsHashFromMetadata =
        headResponse.Metadata?.cid ||
        headResponse.Metadata?.['ipfs-hash'] ||
        headResponse.Metadata?.['x-amz-meta-cid'] || // explicit check if case is weird
        headResponse.Metadata?.['ipfs-pin-status']; // Sometimes the hash is in the status/other fields

      const finalHash = ipfsHashFromMetadata || headResponse.ETag?.replace(/"/g, '') || key;

      // Log all available metadata to debug if we're still missing the CID
      console.log('--- HeadObject Metadata Check ---');
      console.log('HeadResponse Metadata:', headResponse.Metadata);
      console.log('HeadResponse ETag:', headResponse.ETag);
      console.log('Derived Hash:', finalHash);
      console.log('---------------------------------');

      if (!finalHash || (!finalHash.startsWith('Qm') && !finalHash.startsWith('b'))) {
        console.warn(`WARNING: HeadObject failed to retrieve a standard IPFS CID (Qm/b). Using fallback hash: ${finalHash}.`);
      }

      // 3. Construct the final IPFS URL
      const ipfsUrl = `${this.filebaseGateway}/${finalHash}`;

      console.log('File uploaded to Filebase:', {
        bucket: this.bucketName,
        key,
        ipfsHash: finalHash,
        ipfsUrl,
        size: content.length,
        etag: response.ETag
      });

      return ipfsUrl;
    } catch (error: any) {
      console.error('Filebase S3 upload error:', {
        message: error.message,
        name: error.name,
        stack: error.stack,
        ...(error.$metadata || {})
      });
      throw new Error(`Failed to upload to Filebase S3: ${error.message}`);
    }
  }

  async uploadMetadata(req: {
    name: string;
    symbol: string;
    description?: string;
    external_url?: string;
    imageBuffer?: Buffer;
    imageFileName?: string;
    socials?: {
      twitter?: string;
      website?: string;
      telegram?: string;
    };
  }): Promise<{ uri: string; imageUrl: string }> {
    console.log('Starting metadata upload for token:', {
      name: req.name,
      symbol: req.symbol,
      hasImage: !!req.imageBuffer,
      imageSize: req.imageBuffer?.length
    });

    let imageUrl = '';

    if (req.imageBuffer && req.imageFileName) {
      console.log('Uploading image to Filebase...');
      const imagePath = `images/${Date.now()}-${req.imageFileName}`;
      imageUrl = await this.uploadToFilebase(
        req.imageBuffer,
        imagePath,
        'image/jpeg'
      );
      console.log("Image uploaded successfully:", imageUrl);
    }

    const metadata = {
      name: req.name,
      symbol: req.symbol,
      description: req.description || `${req.name} token`,
      image: imageUrl || req.external_url || '',
      external_url: req.external_url || '',
      attributes: [
        {
          trait_type: "symbol",
          value: req.symbol
        }
      ]
    };

    const metadataJson = JSON.stringify(metadata, null, 2);
    const metadataId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    const metadataPath = `metadata-${metadataId}.json`;

    const uri = await this.uploadToFilebase(
      Buffer.from(metadataJson),
      metadataPath,
      'application/json'
    );

    console.log('Metadata uploaded with URL:', uri);
    console.log("Metadata uploaded successfully:", uri);

    return { uri, imageUrl };
  }
}