# Makes test/fixtures/vectors.json with the reference code (pye3dc + py3rijndael 0.3.3).
# Usage: python3 -I test/fixtures/make-vectors.py <clone of pye3dc> > test/fixtures/vectors.json
# (py3rijndael installed in that interpreter, e.g. a venv). Never part of the image.
import sys, json, importlib.util, types, time
REF = sys.argv[1]
# Load the reference modules without executing e3dc/__init__ (it imports web deps).
pkg = types.ModuleType("e3dc"); pkg.__path__ = [REF + "/e3dc"]; sys.modules["e3dc"] = pkg
def load(name):
    spec = importlib.util.spec_from_file_location("e3dc." + name, f"{REF}/e3dc/{name}.py")
    mod = importlib.util.module_from_spec(spec); sys.modules["e3dc." + name] = mod
    spec.loader.exec_module(mod); return mod
tags = load("_rscpTags"); lib = load("_rscpLib"); enc = load("_RSCPEncipherDecipher")
from py3rijndael import Rijndael
out = {}
# 1. Raw Rijndael-256 blocks (key 256 bits, block 256 bits).
blocks = []
for key, plain in [
    (bytes(32), bytes(32)),
    (bytes(range(32)), bytes(range(32))),
    (b"abc123".ljust(32, b"\xff"), b"\xff" * 32),
    (bytes((i * 37 + 11) & 0xff for i in range(32)), bytes((i * 91 + 7) & 0xff for i in range(32))),
]:
    r = Rijndael(key, block_size=32)
    c = r.encipher(plain)
    assert r.decipher(c) == plain
    blocks.append({"key": key.hex(), "plain": plain.hex(), "cipher": c.hex()})
out["blocks"] = blocks
# 2. Frames of the reference with a fixed clock.
lib.time.time = lambda: 1700000000.25
T, Y = tags.RscpTag, tags.RscpType
auth = (T.RSCP_REQ_AUTHENTICATION, Y.Container, [
    (T.RSCP_AUTHENTICATION_USER, Y.CString, "user@example.com"),
    (T.RSCP_AUTHENTICATION_PASSWORD, Y.CString, "secret-pass"),
])
auth_frame = lib.rscpFrame(lib.rscpEncode(auth))
poll = lib.rscpEncode(T.EMS_REQ_POWER_PV, Y.NoneType, None)
db = lib.rscpEncode((T.DB_REQ_HISTORY_DATA_DAY, Y.Container, [
    (T.DB_REQ_HISTORY_TIME_START, Y.Uint64, 1700000000),
    (T.DB_REQ_HISTORY_TIME_INTERVAL, Y.Uint64, 86400),
    (T.DB_REQ_HISTORY_TIME_SPAN, Y.Uint64, 86400),
]))
out["tlv"] = {"poll": poll.hex(), "db": db.hex(), "auth": lib.rscpEncode(auth).hex()}
out["frame_auth"] = auth_frame.hex()
# An answer of the device: values of several types in one frame.
answer_data = b"".join([
    lib.rscpEncode(T.RSCP_AUTHENTICATION, Y.UChar8, 10),
    lib.rscpEncode(T.EMS_POWER_PV, Y.Int32, 4321),
    lib.rscpEncode(T.EMS_POWER_GRID, Y.Int32, -1234),
    lib.rscpEncode(T.EMS_BAT_SOC, Y.UChar8, 77),
    lib.rscpEncode(T.EMS_AUTARKY, Y.Float32, 87.5),
    lib.rscpEncode(T.INFO_SERIAL_NUMBER, Y.CString, "S10-123456789012"),
    lib.rscpEncode((T.DB_HISTORY_DATA_DAY, Y.Container, [
        (T.DB_SUM_CONTAINER, Y.Container, [
            (T.DB_DC_POWER, Y.Float32, 12345.5),
            (T.DB_BAT_POWER_IN, Y.Float32, 4000.0),
        ]),
    ])),
    lib.rscpEncode(T.EMS_POWER_WB_ALL, Y.Error, (6).to_bytes(4, "little")),
])
answer = lib.rscpFrame(answer_data)
dec = lib.rscpDecode(answer)
out["frame_answer"] = answer.hex()
out["frame_answer_first"] = [dec[0][0], dec[0][1], dec[0][2]]
# 3. CBC of the reference: two messages sent, and the device's two answers
#    deciphered as one stream cut at odd places.
key = "abc123"
sender = enc.RSCPEncipherDecipher(key.encode())
c1 = sender.encipher(auth_frame)
c2 = sender.encipher(answer)
out["cbc"] = {"key": key, "plain1": auth_frame.hex(), "cipher1": c1.hex(), "plain2": answer.hex(), "cipher2": c2.hex()}
recv = enc.RSCPEncipherDecipher(key.encode())
d1 = recv.decipher(c1)
d2 = recv.decipher(c2)
assert d1[:len(auth_frame)] == auth_frame and d2[:len(answer)] == answer
# A long key (32 bytes) and the longest padding case.
key32 = "K" * 32
s = enc.RSCPEncipherDecipher(key32.encode())
p = bytes(range(33))
out["cbc32"] = {"key": key32, "plain": p.hex(), "cipher": s.encipher(p).hex()}
print(json.dumps(out, indent=1))
