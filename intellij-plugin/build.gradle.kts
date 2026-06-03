import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.3.0"
}

group   = "com.promptproxy"
version = "2.9.7"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Target IntelliJ IDEA Community 2024.1+.
        // Swap "IC" for "IU" to target Ultimate, or "GO"/"PY"/etc. for other IDEs.
        create("IC", "2024.1")
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginVerification {
        ides {
            ide("IC", "2024.1")
        }
    }
}

kotlin {
    jvmToolchain(17)
}

val generatedEngineResources = layout.buildDirectory.dir("generated-resources/promptOptimizer")

sourceSets {
    named("main") {
        resources.srcDir(generatedEngineResources)
    }
}

tasks {
    patchPluginXml {
        sinceBuild.set("241")   // 2024.1
        untilBuild.set("251.*") // 2025.1.*
    }

    // Sign and publish require environment variables set in CI:
    //   CERTIFICATE_CHAIN, PRIVATE_KEY, PRIVATE_KEY_PASSWORD, PUBLISH_TOKEN
    signPlugin {
        certificateChain.set(System.getenv("CERTIFICATE_CHAIN") ?: "")
        privateKey.set(System.getenv("PRIVATE_KEY") ?: "")
        password.set(System.getenv("PRIVATE_KEY_PASSWORD") ?: "")
    }

    publishPlugin {
        token.set(System.getenv("PUBLISH_TOKEN") ?: "")
    }

    // Ensure the Node.js engine dist is copied into plugin resources before build.
    processResources {
        dependsOn("copyEngine")
    }
}

// ── Copy the compiled Node.js engine dist into plugin resources ───────────────
tasks.register<Copy>("copyEngine") {
    group = "build"
    description = "Copies the packaged prompt-optimizer engine runtime into plugin resources."
    val packagedEngine = rootProject.file("../vscode-extension/engine")
    val engineDist = rootProject.file("../dist")
    if (packagedEngine.exists()) {
        from(packagedEngine)
        into(generatedEngineResources.map { it.dir("engine") })
    } else if (engineDist.exists()) {
        from(engineDist)
        into(generatedEngineResources.map { it.dir("engine/dist") })
    } else {
        doFirst {
            logger.warn(
                "[PromptProxy] Engine runtime not found at ${packagedEngine.absolutePath}. " +
                "Run 'npm --prefix vscode-extension run compile' or 'npm run build' first."
            )
        }
    }
}
