import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { createGenericFile, keypairIdentity } from '@metaplex-foundation/umi';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { getRpcUrl } from './rpcConfig.js';
import { metadataDocumentHash } from './brandShieldService.js';

export const DEFAULT_IRYS_ADDRESS = 'https://node1.irys.xyz';
export const DEFAULT_IRYS_TIMEOUT_MS = 60000;
export const PLACEHOLDER_TOKEN_IMAGE_URI = 'https://arweave.net/placeholder-token-image';
export const SEALED_TOKEN_NAME = 'Trebuchet Sealed Launch';
export const SEALED_TOKEN_SYMBOL = 'SEALED';

export function tokenMetadataJson({ name, symbol, description, imageUri }) {
  return {
    name,
    symbol,
    description,
    image: imageUri,
  };
}

export function logoDataUrlToGenericFile(logoBase64) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(logoBase64 || ''));
  if (!match) {
    throw new Error('logo must be a base64 data URL');
  }

  const [, mimeType, base64Data] = match;
  return createGenericFile(Buffer.from(base64Data, 'base64'), 'logo', {
    tags: [{ name: 'Content-Type', value: mimeType }],
  });
}

export function createMetadataUmi({
  rpcUrl = getRpcUrl(),
  irysAddress = DEFAULT_IRYS_ADDRESS,
  timeout = DEFAULT_IRYS_TIMEOUT_MS,
} = {}) {
  return createUmi(rpcUrl)
    .use(mplTokenMetadata())
    .use(irysUploader({
      address: irysAddress,
      timeout,
    }));
}

export function setMetadataUploaderIdentity(umi, tempWallet) {
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(tempWallet.secretKey);
  umi.use(keypairIdentity(umiKeypair));
  return umi;
}

export function createTokenMetadataUmi(tempWallet, options = {}) {
  return setMetadataUploaderIdentity(createMetadataUmi(options), tempWallet);
}

export async function uploadTokenMetadata({
  umi,
  logoBase64,
  name,
  symbol,
  description,
  onProgress,
  logger = console,
  placeholderImageUri = PLACEHOLDER_TOKEN_IMAGE_URI,
}) {
  let imageUri = placeholderImageUri;

  if (logoBase64) {
    try {
      const logoFile = logoDataUrlToGenericFile(logoBase64);
      const [uploadedImageUri] = await umi.uploader.upload([logoFile]);
      imageUri = uploadedImageUri;
      logger.log?.('Logo uploaded:', imageUri);
      onProgress?.({ stage: 'logo_uploaded', imageUri });
    } catch (uploadError) {
      logger.error?.('Error uploading logo:', uploadError);
      imageUri = placeholderImageUri;
      onProgress?.({
        stage: 'logo_upload_failed',
        error: uploadError?.message || String(uploadError),
      });
    }
  }

  const metadata = tokenMetadataJson({ name, symbol, description, imageUri });
  const metadataUri = await umi.uploader.uploadJson(metadata);
  const metadataHash = metadataDocumentHash(metadata);
  logger.log?.('Metadata uploaded:', metadataUri);
  onProgress?.({ stage: 'metadata_uploaded', metadataUri, imageUri, metadataHash });

  return { metadataUri, imageUri, metadata, metadataHash };
}

export async function uploadSealedPlaceholderMetadata({
  umi,
  commitmentHash,
  onProgress,
  logger = console,
  placeholderImageUri = PLACEHOLDER_TOKEN_IMAGE_URI,
}) {
  const shortCommitment = String(commitmentHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(shortCommitment)) {
    throw new Error('Sealed metadata requires a SHA-256 commitment.');
  }
  const metadata = tokenMetadataJson({
    name: SEALED_TOKEN_NAME,
    symbol: SEALED_TOKEN_SYMBOL,
    description: `Identity committed by Trebuchet: sha256:${shortCommitment}`,
    imageUri: placeholderImageUri,
  });
  const metadataUri = await umi.uploader.uploadJson(metadata);
  logger.log?.('Sealed placeholder metadata uploaded:', metadataUri);
  onProgress?.({
    stage: 'sealed_metadata_prepared',
    onChainMetadataUri: metadataUri,
    metadataCommitment: shortCommitment,
  });
  return { metadataUri, metadata };
}
