package infrastructure

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type MinIOStore struct {
	client        *minio.Client
	presignClient *minio.Client
	bucket        string
	expiresIn     time.Duration
}

func NewMinIOStore(endpoint string, publicEndpoint string, accessKey string, secretKey string, secure bool, publicSecure bool, bucket string) (*MinIOStore, error) {
	client, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: secure, Region: "us-east-1"})
	if err != nil {
		return nil, fmt.Errorf("create minio client: %w", err)
	}
	presignClient, err := minio.New(publicEndpoint, &minio.Options{Creds: credentials.NewStaticV4(accessKey, secretKey, ""), Secure: publicSecure, Region: "us-east-1"})
	if err != nil {
		return nil, fmt.Errorf("create public minio client: %w", err)
	}
	return &MinIOStore{client: client, presignClient: presignClient, bucket: bucket, expiresIn: 10 * time.Minute}, nil
}

func (store *MinIOStore) CreateUploadURL(ctx context.Context, objectKey string, _ string, _ int64) (string, error) {
	presigner := store.presignClient
	if application.UsesInternalUploadURL(ctx) {
		presigner = store.client
	}
	url, err := presigner.PresignedPutObject(ctx, store.bucket, objectKey, store.expiresIn)
	if err != nil {
		return "", fmt.Errorf("presign minio put object: %w", err)
	}
	return url.String(), nil
}

func (store *MinIOStore) ReadObject(ctx context.Context, objectKey string) (application.StoredObject, error) {
	object, err := store.client.GetObject(ctx, store.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return application.StoredObject{}, fmt.Errorf("get minio object: %w", err)
	}
	defer object.Close()
	stat, err := object.Stat()
	if err != nil {
		return application.StoredObject{}, fmt.Errorf("stat minio object: %w", err)
	}
	if stat.Size > application.MaxReceiptSizeBytes {
		return application.StoredObject{}, application.ErrInvalidReceiptSize
	}
	content, err := io.ReadAll(io.LimitReader(object, application.MaxReceiptSizeBytes+1))
	if err != nil {
		return application.StoredObject{}, fmt.Errorf("read minio object: %w", err)
	}
	if int64(len(content)) > application.MaxReceiptSizeBytes {
		return application.StoredObject{}, application.ErrInvalidReceiptSize
	}
	return application.StoredObject{ContentType: stat.ContentType, Content: content}, nil
}

func (store *MinIOStore) DeleteObject(ctx context.Context, objectKey string) error {
	if err := store.client.RemoveObject(ctx, store.bucket, objectKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("delete minio object: %w", err)
	}
	return nil
}
