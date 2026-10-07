package infrastructure

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

type ClamAVScanner struct {
	address string
	timeout time.Duration
}

func NewClamAVScanner(address string) *ClamAVScanner {
	return &ClamAVScanner{address: address, timeout: 20 * time.Second}
}

func (scanner *ClamAVScanner) Scan(ctx context.Context, content []byte) (bool, error) {
	connection, err := (&net.Dialer{Timeout: scanner.timeout}).DialContext(ctx, "tcp", scanner.address)
	if err != nil {
		return false, fmt.Errorf("connect clamav: %w", err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(scanner.timeout)); err != nil {
		return false, fmt.Errorf("set clamav deadline: %w", err)
	}
	if _, err = connection.Write([]byte("zINSTREAM\x00")); err != nil {
		return false, fmt.Errorf("start clamav stream: %w", err)
	}
	for offset := 0; offset < len(content); {
		end := offset + 16*1024
		if end > len(content) {
			end = len(content)
		}
		chunk := content[offset:end]
		var size [4]byte
		binary.BigEndian.PutUint32(size[:], uint32(len(chunk)))
		if _, err = connection.Write(size[:]); err != nil {
			return false, fmt.Errorf("write clamav chunk size: %w", err)
		}
		if _, err = connection.Write(chunk); err != nil {
			return false, fmt.Errorf("write clamav chunk: %w", err)
		}
		offset = end
	}
	if _, err = connection.Write([]byte{0, 0, 0, 0}); err != nil {
		return false, fmt.Errorf("finish clamav stream: %w", err)
	}
	response, err := io.ReadAll(io.LimitReader(connection, 4*1024))
	if err != nil {
		return false, fmt.Errorf("read clamav result: %w", err)
	}
	message := string(response)
	if strings.Contains(message, "FOUND") {
		return true, nil
	}
	if strings.Contains(message, "OK") {
		return false, nil
	}
	return false, fmt.Errorf("unexpected clamav response: %s", strings.TrimSpace(message))
}
