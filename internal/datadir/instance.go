package datadir

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
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
// and a port as net.JoinHostPort writes them; pid is its process id,
// from 1 to math.MaxInt32 (the range a pid has on every supported
// system; a reader refuses any other).
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
	// Whatever an earlier run left at the temporary name goes first (a
	// link is removed, never followed), and the file is then created
	// new: O_EXCL refuses anything that took the name in between, a
	// link included, so the write never lands outside the data dir.
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	_, werr := f.Write(append(data, '\n'))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", tmp, werr)
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
// when there is none. It is read only when openInstance trusts it (a
// regular file that is not a link; on Unix also one link, owned with
// the data dir by this user, and neither writable by other users),
// since whoever could write it could point an agent at a server of
// their own on this machine, and only when it is at most
// maxInstanceBytes with a pid in range. The record says only what an
// instance wrote; whether that instance still runs is the caller's to
// check.
func ReadInstance(dir string) (Instance, error) {
	path := filepath.Join(dir, InstanceFile)
	f, err := openInstance(path, dir)
	if err != nil {
		return Instance{}, err
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
	if inst.PID > math.MaxInt32 {
		// No process has it, and a larger value wraps to 0, -1 or a low
		// pid in a 32-bit system call (0 and -1 name process groups).
		return Instance{}, fmt.Errorf("%s names a process id out of range", path)
	}
	return inst, nil
}

// errNotRegular is part of the refusal of an instance file that is a
// link, a directory, a device or a pipe.
var errNotRegular = errors.New("not a regular file")

// openNotExist turns the open error of an instance file that is not
// there into ErrNoInstance.
func openNotExist(path string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNoInstance
	}
	return fmt.Errorf("open %s: %w", path, err)
}
