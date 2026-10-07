package infrastructure

import (
	"context"
	"io"
	"net"
	"testing"
)

func TestClamAVScannerHandlesCleanAndInfectedResponses(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		response string
		unsafe   bool
	}{
		{name: "clean", response: "stream: OK\x00", unsafe: false},
		{name: "infected", response: "stream: Eicar-Test-Signature FOUND\x00", unsafe: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("listen: %v", err)
			}
			defer listener.Close()
			go func() {
				connection, acceptErr := listener.Accept()
				if acceptErr != nil {
					return
				}
				defer connection.Close()
				buffer := make([]byte, 10)
				_, _ = io.ReadFull(connection, buffer)
				for {
					length := make([]byte, 4)
					if _, err := io.ReadFull(connection, length); err != nil {
						return
					}
					size := int(length[0])<<24 | int(length[1])<<16 | int(length[2])<<8 | int(length[3])
					if size == 0 {
						break
					}
					if _, err := io.CopyN(io.Discard, connection, int64(size)); err != nil {
						return
					}
				}
				_, _ = connection.Write([]byte(testCase.response))
			}()

			unsafe, err := NewClamAVScanner(listener.Addr().String()).Scan(context.Background(), []byte("receipt"))
			if err != nil {
				t.Fatalf("scan: %v", err)
			}
			if unsafe != testCase.unsafe {
				t.Fatalf("expected unsafe=%t, got %t", testCase.unsafe, unsafe)
			}
		})
	}
}
