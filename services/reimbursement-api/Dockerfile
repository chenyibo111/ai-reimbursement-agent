FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o /out/reimbursement-api ./cmd/api

FROM alpine:3.22
RUN adduser -D -u 10001 app
USER app
COPY --from=build /out/reimbursement-api /usr/local/bin/reimbursement-api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/reimbursement-api"]
