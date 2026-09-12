// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "HablablaModelWorker",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "hablabla-model-worker", targets: ["HablablaModelWorker"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "c7562faf29f07b7634d2b99d41679c6ff430f3b3"
        ),
        .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.30.6"),
        .package(path: "Vendor/MLXAudioMOSS"),
    ],
    targets: [
        .executableTarget(
            name: "HablablaModelWorker",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "MLXAudioCore", package: "MLXAudioMOSS"),
                .product(name: "MLXAudioSTT", package: "MLXAudioMOSS"),
                .product(name: "MLX", package: "mlx-swift"),
            ]
        ),
    ]
)
