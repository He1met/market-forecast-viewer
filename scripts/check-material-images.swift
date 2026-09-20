// Offline macOS Vision screening; output is local review evidence, not approval.
import Foundation
import Vision
import CryptoKit
guard CommandLine.arguments.count == 3 else { fatalError("Usage: check-material-images input.json new-output.jsonl") }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let paths = try JSONSerialization.jsonObject(with: Data(contentsOf: input)) as! [String]
try Data().write(to: output, options: .withoutOverwriting)
let handle = try FileHandle(forWritingTo: output)
defer { try? handle.close() }
for path in paths {
    var result: [String: Any] = ["path": path]
    do {
        let source = try Data(contentsOf: URL(fileURLWithPath: path))
        result["source_sha256"] = SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(data: source, options: [:]).perform([request])
        result["lines"] = (request.results ?? []).compactMap { observation -> [String: Any]? in
            guard let top = observation.topCandidates(1).first else { return nil }
            return ["text": top.string, "confidence": top.confidence]
        }
        result["status"] = "screened_requires_classification"
    } catch { result["status"] = "error"; result["error"] = String(describing: error) }
    var data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    data.append(0x0a)
    try handle.write(contentsOf: data)
}
