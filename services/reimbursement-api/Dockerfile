FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o /out/reimbursement-api ./cmd/api \
    && go build -o /out/reimbursement-worker ./cmd/worker \
    && go build -o /out/legacy-import ./cmd/legacy-import

FROM nats:2.10-alpine
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/reimbursement-api /usr/local/bin/reimbursement-api
COPY --from=build /out/reimbursement-worker /usr/local/bin/reimbursement-worker
COPY --from=build /out/legacy-import /usr/local/bin/legacy-import
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/reimbursement-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/reimbursement-entrypoint", "/usr/local/bin/reimbursement-api"]
