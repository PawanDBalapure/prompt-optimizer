## 🏗️ Architecture & Design

* Loose Coupling: Separate business logic from external frameworks and databases.
* Dependency Inversion: Depend upon abstract interfaces, not concrete implementations.
* Single Responsibility: Ensure each module or class has one reason to change.
* Immutability First: Default to immutable data structures to prevent state bugs.
* Plug-in Architecture: Treat third-party tools as easily replaceable components. [1, 2, 3, 4, 5] 

## ✍️ Code Standards

* Self-Documenting Code: Name variables by intent, not by technical type.
* Standardized Style: Enforce automated linting and formatting on every commit.
* Small Functions: Limit functions to fewer than 20 lines of code.
* No Magic Values: Replace raw numbers and strings with named constants.
* Pure Functions: Minimize side effects by prioritizing predictable inputs and outputs. [6, 7, 8, 9, 10] 

## 🧪 Testing & Validation

* Pyramid Strategy: Maintain high unit test coverage and lean integration tests.
* Regression Shields: Write tests for every discovered bug before fixing it.
* Deterministic Tests: Eliminate flaky tests by mocking time, network, and randomness.
* CI/CD Enforcement: Block code merges if automated test suites fail.
* Boundary Testing: Validate extreme inputs, null values, and empty states explicitly. [11, 12, 13, 14, 15] 

## 📦 Dependency Management

* Zero-Dependency Bias: Prefer native language features over external micro-libraries.
* Strict Pinning: Lock exact versions of all dependencies and build tools.
* Automated Audits: Scan dependencies weekly for security vulnerabilities and deprecations.
* Isolation Layers: Wrap external APIs in local adapter classes. [16, 17, 18, 19, 20] 

## 📖 Documentation & Knowledge

* Readme-Driven: Maintain an updated setup guide in the root directory.
* Decision Records: Document architectural choices using Architecture Decision Records (ADRs).
* Code Intent: Use comments to explain why code exists, not what it does.
* Self-Contained Setup: Script environment provisioning so new devs onboard in minutes. [21, 22, 23, 24, 25] 

## 🔄 Evolution & Maintenance

* Continuous Refactoring: Upgrade language versions and libraries at least twice yearly.
* Feature Flags: Wrap new changes in toggles to allow safe rollbacks.
* Graceful Degradation: Design systems to fail safely without crashing the platform.
* Sunset Policies: Explicitly deprecate and remove unused features and code paths. [26, 27, 28, 29] 
