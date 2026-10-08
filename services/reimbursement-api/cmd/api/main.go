package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/infrastructure"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
	transport "github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/transport/http"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	databaseURL := strings.TrimSpace(os.Getenv("REIMBURSEMENT_DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("REIMBURSEMENT_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect reimbursement database: %v", err)
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		log.Fatalf("ping reimbursement database: %v", err)
	}
	objects, err := minIOFromEnvironment()
	if err != nil {
		log.Fatalf("configure object storage: %v", err)
	}
	clamAddress := strings.TrimSpace(os.Getenv("CLAMAV_HOST")) + ":" + strings.TrimSpace(os.Getenv("CLAMAV_PORT"))
	if strings.HasPrefix(clamAddress, ":") || strings.HasSuffix(clamAddress, ":") {
		log.Fatal("CLAMAV_HOST and CLAMAV_PORT are required")
	}
	ocrURL := strings.TrimSpace(os.Getenv("OCR_SERVICE_URL"))
	if ocrURL == "" {
		log.Fatal("OCR_SERVICE_URL is required")
	}
	claimRepository := store.NewPostgresClaimRepository(pool)
	provisioningKey := strings.TrimSpace(os.Getenv("REIMBURSEMENT_AUTH_PROVISIONING_KEY"))
	if os.Getenv("REIMBURSEMENT_DEV_AUTH") != "true" && provisioningKey == "" {
		log.Fatal("REIMBURSEMENT_AUTH_PROVISIONING_KEY is required")
	}

	var resolver transport.ActorResolver
	if os.Getenv("REIMBURSEMENT_DEV_AUTH") == "true" {
		resolver = transport.StaticActorResolver{}
	} else {
		web, webErr := transport.NewWebBearerResolver(os.Getenv("REIMBURSEMENT_AUTH_HS256_SECRET"), "reimbursement-api", transport.EmployeeActivityFunc(store.EmployeeIsActive(pool)))
		if webErr != nil {
			log.Fatalf("configure bearer authentication: %v", webErr)
		}
		if serviceKey := strings.TrimSpace(os.Getenv("REIMBURSEMENT_AGENT_SERVICE_KEY")); serviceKey != "" {
			bearer, bearerErr := transport.NewHS256BearerResolver(os.Getenv("REIMBURSEMENT_AUTH_HS256_SECRET"), "reimbursement-api")
			if bearerErr != nil {
				log.Fatalf("configure delegated agent authentication: %v", bearerErr)
			}
			agent, agentErr := transport.NewDelegatedAgentResolver(bearer, serviceKey, transport.EmployeeActivityFunc(store.EmployeeIsActive(pool)))
			if agentErr != nil {
				log.Fatalf("configure delegated agent authentication: %v", agentErr)
			}
			resolver = transport.NewCombinedActorResolver(web, agent)
		} else {
			resolver = web
		}
	}
	ocrSuggestionRefresher := claimRepository
	router := transport.NewRouter(transport.Dependencies{
		Claims:             application.NewClaimService(claimRepository, application.SecureIDGenerator{}, store.NewPostgresClaimNumberGenerator(pool), time.Now, ocrSuggestionRefresher),
		Submissions:        application.NewSubmissionService(store.NewPostgresSubmissionRepository(pool), nil),
		Receipts:           application.NewReceiptService(claimRepository, store.NewPostgresReceiptRepository(pool), objects, infrastructure.NewClamAVScanner(clamAddress), infrastructure.NewHTTPReceiptOCRClient(ocrURL), application.SecureIDGenerator{}, ocrSuggestionRefresher),
		Admin:              transport.AdminServices{Policies: application.NewPolicyRuleService(store.NewPostgresPolicyRuleRepository(pool)), Reviews: application.NewReviewCaseService(store.NewPostgresReviewCaseRepository(pool)), Role: store.EmployeeRole(pool)},
		EmployeeIdentities: application.NewEmployeeIdentityService(store.NewPostgresEmployeeIdentityRepository(pool)),
		ProvisioningKey:    provisioningKey,
		Auth:               resolver,
	})
	address := os.Getenv("PORT")
	if address == "" {
		address = "8080"
	}
	server := &http.Server{Addr: ":" + address, Handler: router, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("reimbursement API listening on %s", server.Addr)
	log.Fatal(server.ListenAndServe())
}

func minIOFromEnvironment() (*infrastructure.MinIOStore, error) {
	rawEndpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	parsed, err := url.Parse(rawEndpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("S3_ENDPOINT must be an http(s) URL")
	}
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	accessKey := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("S3_SECRET_ACCESS_KEY"))
	if bucket == "" || accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required")
	}
	return infrastructure.NewMinIOStore(parsed.Host, accessKey, secretKey, parsed.Scheme == "https", bucket)
}
