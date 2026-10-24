# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local reading of an E3/DC home storage system (S10, Quattroporte) through
  RSCP, as the pye3dc library does: log-in with the E3/DC account, frames
  enciphered with the RSCP password (Rijndael-256, written in plain
  JavaScript), the live values and the energies of the day, every 30 s by
  default (30 to 300 s). The E3/DC portal is never contacted. Read-only.
- One device per system, its external id from its serial number: state of
  charge, battery power and grid power (signed, as read), solar power, house
  consumption, additional source, autarky, self-consumption, wallbox power
  (total and solar), and the energies of the day (solar, battery charge and
  discharge, taken from and sent into the grid, house consumption).
- The solar production index for the energy monitoring, built from the
  counter of the day and checked by the guard of gladys-p1-monitor (a jump held
  until "Accept the held index" is clicked twice, a drop never accepted: it
  corrects itself); option "Sensor
  only" against a double count.
- A refused log-in (or no readable answer to it twice in a row) stops the
  reads until the form changes, kept in `/data`; one try per click of "Test
  the connection".
