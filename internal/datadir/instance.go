package datadir

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// InstanceFile is the name of the file in a data dir that says where the
// instance holding the data dir's lock listens, while it runs on
// loopback. `flightdeck connect` reads it to find the running server.
//
// The format is one JSON object:
//
//	{"listen": "127.0.0.1:4100", "pid": 12345}
//
// listen is the address the instance's listener bound, an IP address
// and a port as net.JoinHostPort writes them; pid is its process id.
// Readers ignore members they do not know, so one may be added. The
// file holds no token and nothing secret; it has the mode of the data
// dir's other files, 0600.
const InstanceFile = "instance.json"

// maxInstanceBytes bounds what is read of the file. The object is about
// forty bytes; four kibibytes is far past any version of it, and a
// larger file is not one.
const maxInstanceBytes = 4096

// Instance is what InstanceFile holds.
type Instance struct {
	// Listen is the bound address, host:port with an IP host.
	Listen string `json:"listen"`
	// PID is the process that wrote the file.
	PID int `json:"pid"`
}

// ErrNoInstance is returned by ReadInstance when the data dir holds no
// instance file.
var ErrNoInstance = errors.New("no instance file")

// WriteInstance writes inst into dir's instance file with mode 0600,
// through a temporary file in the same directory, so a reader never
// sees half of it. Call it only while holding the data dir's lock.
func WriteInstance(dir string, inst Instance) error {
	data, err := json.Marshal(inst)
	if err != nil {
		return fmt.Errorf("encode %s: %w", InstanceFile, err)
	}
	path := filepath.Join(dir, InstanceFile)
	tmp := path + ".tmp"
	// A temporary file an earlier run left goes first: WriteFile keeps
	// the mode of a file that exists.
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// RemoveInstance removes dir's instance file; none there is no error.
// Call it only while holding the data dir's lock: the file belongs to
// the holder.
func RemoveInstance(dir string) error {
	err := os.Remove(filepath.Join(dir, InstanceFile))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", filepath.Join(dir, InstanceFile), err)
	}
	return nil
}

// ReadInstance returns what dir's instance file holds, ErrNoInstance
// when there is none. It is read only when it is a regular file (not a
// link) of at most maxInstanceBytes and, on Unix, neither the file nor
// dir can be written by other users: another user who could write it
// could point an agent at a server of their own on this machine. The
// record says only what an instance wrote; whether that instance still
// runs is the caller's to check.
func ReadInstance(dir string) (Instance, error) {
	path := filepath.Join(dir, InstanceFile)
	info, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Instance{}, ErrNoInstance
	case err != nil:
		return Instance{}, fmt.Errorf("stat %s: %w", path, err)
	case !info.Mode().IsRegular():
		return Instance{}, fmt.Errorf("%s is not a regular file", path)
	}
	if runtime.GOOS != "windows" {
		if info.Mode().Perm()&0o022 != 0 {
			return Instance{}, fmt.Errorf("%s can be written by other users (mode %04o)", path, info.Mode().Perm())
		}
		dirInfo, err := os.Stat(dir)
		if err != nil {
			return Instance{}, fmt.Errorf("stat %s: %w", dir, err)
		}
		if dirInfo.Mode().Perm()&0o022 != 0 {
			return Instance{}, fmt.Errorf("data dir %s can be written by other users (mode %04o)", dir, dirInfo.Mode().Perm())
		}
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// Removed by a stop since the Lstat.
			return Instance{}, ErrNoInstance
		}
		return Instance{}, fmt.Errorf("read %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxInstanceBytes+1))
	if err != nil {
		return Instance{}, fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) > maxInstanceBytes {
		return Instance{}, fmt.Errorf("%s is larger than an instance file (%d bytes at most)", path, maxInstanceBytes)
	}
	var inst Instance
	if err := json.Unmarshal(data, &inst); err != nil {
		return Instance{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if inst.Listen == "" || inst.PID <= 0 {
		return Instance{}, fmt.Errorf("%s names no address and process", path)
	}
	return inst, nil
}
