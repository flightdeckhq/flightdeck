//go:build !race

package main

// raceBuild reports whether the test binary, and so every child it
// starts as the flightdeck binary, is built with the race detector.
const raceBuild = false
