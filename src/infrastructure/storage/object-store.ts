import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type ObjectStore = {
  put(input: { key: string; bytes: Uint8Array; mimeType: string }): Promise<void>;
  get(input: { key: string }): Promise<Uint8Array>;
};

export type S3ObjectStoreConfig = {
  endpoint?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    forcePathStyle: Boolean(config.endpoint),
    region: "us-east-1",
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
  });

  return {
    async put(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: input.mimeType,
        }),
      );
    },
    async get(input) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: input.key }));
      const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new Error("stored object body is missing");
      return body.transformToByteArray();
    },
  };
}
