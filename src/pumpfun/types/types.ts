export interface TokenCreationRequest {
  name: string;
  symbol: string;
  creatorKeypair: string;
  creator?: string; // Optional creator public key
  imagePath: string;
  description?: string;
  imageFileName?: string;
  imageBuffer?: Buffer;
  external_url?: string;
  attributes?: Array<{ trait_type: string; value: string }>;
  uri?: string; // pre generated uri
  buyAmount?: number;
  mayhemMode?: boolean; // Enable mayhem mode for the token
  extensions?: { [key: string]: string }; // For social media links
}
