import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.3.0"
}

group   = "com.promptproxy"
version = "2.7.2"

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

kotlin {
    jvmToolchain(17)
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
    description = "Copies the compiled prompt-proxy-engine dist into plugin resources."
    val engineDist = rootProject.file("../dist")
    if (engineDist.exists()) {
        from(engineDist)
        into(layout.projectDirectory.dir("src/main/resources/engine/dist"))
    } else {
        doFirst {
            logger.warn(
                "[PromptProxy] Engine dist not found at ${engineDist.absolutePath}. " +
                "Run 'npm run build' in the repo root first."
            )
        }
    }
}
