#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Fetch ICEpdf and its runtime dependencies from Maven Central into
# ${OUT}/icepdf/. The harness loads them through CheerpJ.
#
# Outputs:
#   ${OUT}/icepdf/*.jar
#   ${OUT}/icepdf/icepdf-cheerpj-patches.jar
#   ${OUT}/icepdf/icepdf.jars.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-${ROOT}/.build-src}"

ICEPDF_VERSION="${ICEPDF_VERSION:-7.4.0}"
ICEPDF_JAVA_RELEASE="${ICEPDF_JAVA_RELEASE:-11}"
BOUNCYCASTLE_VERSION="${BOUNCYCASTLE_VERSION:-1.83}"
TWELVEMONKEYS_VERSION="${TWELVEMONKEYS_VERSION:-3.13.1}"
# resolve-upstream.mjs exports this as ICEPDF_PDFBOX_VERSION to avoid
# clashing with the standalone PDFBox renderer's PDFBOX_VERSION; fall back
# to the unprefixed name when run from the icepdf.yml-only path.
ICEPDF_PDFBOX_VERSION="${ICEPDF_PDFBOX_VERSION:-${PDFBOX_VERSION:-3.0.6}}"
PDFBOX_VERSION="${ICEPDF_PDFBOX_VERSION}"
JBIG2_IMAGEIO_VERSION="${JBIG2_IMAGEIO_VERSION:-3.0.4}"
JAI_IMAGEIO_JPEG2000_VERSION="${JAI_IMAGEIO_JPEG2000_VERSION:-1.4.0}"
# jai-imageio-core and jai-imageio-jpeg2000 are independent Maven artifacts;
# don't pretend they share a version. Pin to a known-good core release.
JAI_IMAGEIO_CORE_VERSION="${JAI_IMAGEIO_CORE_VERSION:-1.4.0}"
COMMONS_LOGGING_VERSION="${COMMONS_LOGGING_VERSION:-1.3.5}"
PATCH_SRC="${SRC_DIR}/icepdf-cheerpj-patches-${ICEPDF_VERSION}/src"
PATCH_CLASSES="${SRC_DIR}/icepdf-cheerpj-patches-${ICEPDF_VERSION}/classes"

command -v javac >/dev/null || {
    echo "icepdf: javac is required for CheerpJ compatibility patches" >&2
    exit 1
}
command -v jar >/dev/null || {
    echo "icepdf: jar is required for CheerpJ compatibility patches" >&2
    exit 1
}

mkdir -p "${OUT}/icepdf"

# Cache Maven jars per (artifact, version) under ${SRC_DIR} so re-running
# this script doesn't re-fetch ~80MB of immutable artifacts.
ICEPDF_JAR_CACHE="${SRC_DIR}/icepdf-jars"
mkdir -p "${ICEPDF_JAR_CACHE}"

download_jar() {
    local group_path="$1"
    local artifact="$2"
    local version="$3"
    local dest="$4"
    local url="https://repo1.maven.org/maven2/${group_path}/${artifact}/${version}/${artifact}-${version}.jar"
    local cached="${ICEPDF_JAR_CACHE}/${artifact}-${version}.jar"
    if [ ! -f "${cached}" ]; then
        curl -fSL -o "${cached}.tmp" "${url}"
        local expected_sha
        expected_sha="$(curl -fsSL "${url}.sha1" || true)"
        if [ -n "${expected_sha}" ]; then
            local got_sha
            got_sha="$(sha1sum "${cached}.tmp" | awk '{print $1}')"
            if [ "${got_sha}" != "${expected_sha}" ]; then
                rm -f "${cached}.tmp"
                echo "icepdf: sha1 mismatch on ${artifact}-${version}.jar" >&2
                exit 1
            fi
        fi
        mv "${cached}.tmp" "${cached}"
    fi
    cp "${cached}" "${OUT}/icepdf/${dest}"
}

download_jar "com/github/pcorless/icepdf" "icepdf-core" "${ICEPDF_VERSION}" "icepdf-core.jar"
download_jar "com/github/pcorless/icepdf" "icepdf-fonts" "${ICEPDF_VERSION}" "icepdf-fonts.jar"
download_jar "org/bouncycastle" "bcprov-jdk18on" "${BOUNCYCASTLE_VERSION}" "bcprov-jdk18on.jar"
download_jar "org/bouncycastle" "bcpkix-jdk18on" "${BOUNCYCASTLE_VERSION}" "bcpkix-jdk18on.jar"
download_jar "org/bouncycastle" "bcutil-jdk18on" "${BOUNCYCASTLE_VERSION}" "bcutil-jdk18on.jar"
download_jar "com/twelvemonkeys/imageio" "imageio-tiff" "${TWELVEMONKEYS_VERSION}" "imageio-tiff.jar"
download_jar "com/twelvemonkeys/imageio" "imageio-core" "${TWELVEMONKEYS_VERSION}" "imageio-core.jar"
download_jar "com/twelvemonkeys/imageio" "imageio-metadata" "${TWELVEMONKEYS_VERSION}" "imageio-metadata.jar"
download_jar "com/twelvemonkeys/common" "common-lang" "${TWELVEMONKEYS_VERSION}" "common-lang.jar"
download_jar "com/twelvemonkeys/common" "common-io" "${TWELVEMONKEYS_VERSION}" "common-io.jar"
download_jar "com/twelvemonkeys/common" "common-image" "${TWELVEMONKEYS_VERSION}" "common-image.jar"
download_jar "org/apache/pdfbox" "fontbox" "${PDFBOX_VERSION}" "fontbox.jar"
download_jar "org/apache/pdfbox" "pdfbox-io" "${PDFBOX_VERSION}" "pdfbox-io.jar"
download_jar "commons-logging" "commons-logging" "${COMMONS_LOGGING_VERSION}" "commons-logging.jar"
download_jar "org/apache/pdfbox" "jbig2-imageio" "${JBIG2_IMAGEIO_VERSION}" "jbig2-imageio.jar"
download_jar "com/github/jai-imageio" "jai-imageio-core" "${JAI_IMAGEIO_CORE_VERSION}" "jai-imageio-core.jar"
download_jar "com/github/jai-imageio" "jai-imageio-jpeg2000" "${JAI_IMAGEIO_JPEG2000_VERSION}" "jai-imageio-jpeg2000.jar"

rm -rf "${PATCH_SRC}" "${PATCH_CLASSES}"
mkdir -p "${PATCH_SRC}/org/icepdf/core/pobjects/graphics" "${PATCH_CLASSES}"

cat > "${PATCH_SRC}/org/icepdf/core/pobjects/graphics/DeviceGray.java" <<'EOF'
package org.icepdf.core.pobjects.graphics;

import org.icepdf.core.pobjects.DictionaryEntries;
import org.icepdf.core.pobjects.Name;
import org.icepdf.core.util.Library;

import java.awt.Color;
import java.util.concurrent.ConcurrentHashMap;

public class DeviceGray extends PColorSpace {
    public static final Name DEVICEGRAY_KEY = new Name("DeviceGray");
    public static final Name G_KEY = new Name("G");

    private static final ConcurrentHashMap<Integer, Color> colorHashMap = new ConcurrentHashMap<>(256);

    public DeviceGray(Library l, DictionaryEntries h) {
        super(l, h);
    }

    public int getNumComponents() {
        return 1;
    }

    public Color getColor(float[] f, boolean fillAndStroke) {
        float gray = component(f, 0);
        if (gray > 1.0f) {
            gray = gray / 255.0f;
        }
        gray = clamp(gray);
        int key = Math.round(gray * 255.0f);
        Color color = colorHashMap.get(key);
        if (color == null) {
            color = new Color(gray, gray, gray);
            colorHashMap.put(key, color);
        }
        return color;
    }

    private static float component(float[] f, int index) {
        return f != null && f.length > index ? f[index] : 0;
    }

    private static float clamp(float value) {
        if (value < 0) {
            return 0;
        }
        if (value > 1) {
            return 1;
        }
        return value;
    }
}
EOF

cat > "${PATCH_SRC}/org/icepdf/core/pobjects/graphics/CalGray.java" <<'EOF'
package org.icepdf.core.pobjects.graphics;

import org.icepdf.core.pobjects.DictionaryEntries;
import org.icepdf.core.pobjects.Name;
import org.icepdf.core.util.Library;

import java.awt.Color;

public class CalGray extends PColorSpace {
    public static final Name WHITE_POINT_KEY = new Name("WhitePoint");
    public static final Name GAMMA_KEY = new Name("Gamma");
    public static final Name MATRIX_KEY = new Name("Matrix");
    public static final Name CAL_GRAY_KEY = new Name("CalGray");

    protected float gamma = 1.0f;

    public CalGray(Library l, DictionaryEntries h) {
        super(l, h);
        Object o = h != null ? h.get(GAMMA_KEY) : null;
        if (o instanceof Float) {
            gamma = (Float) o;
        }
    }

    public Color getColor(float[] f, boolean fillAndStroke) {
        float gray = f != null && f.length > 0 ? f[0] : 0;
        gray = (float) Math.pow(clamp(gray), gamma);
        return new Color(gray, gray, gray);
    }

    public int getNumComponents() {
        return 1;
    }

    private static float clamp(float value) {
        if (value < 0) {
            return 0;
        }
        if (value > 1) {
            return 1;
        }
        return value;
    }
}
EOF

cat > "${PATCH_SRC}/org/icepdf/core/pobjects/graphics/DeviceCMYK.java" <<'EOF'
package org.icepdf.core.pobjects.graphics;

import org.icepdf.core.pobjects.DictionaryEntries;
import org.icepdf.core.pobjects.Name;
import org.icepdf.core.util.Library;

import java.awt.Color;
import java.awt.color.ICC_ColorSpace;

public class DeviceCMYK extends PColorSpace {
    public static final Name DEVICECMYK_KEY = new Name("DeviceCMYK");
    public static final Name CMYK_KEY = new Name("CMYK");

    private static final DeviceGray DEVICE_GRAY = new DeviceGray(null, null);
    private static boolean disableICCCmykColorSpace = true;

    public DeviceCMYK(Library l, DictionaryEntries h) {
        super(l, h);
    }

    public int getNumComponents() {
        return 4;
    }

    public Color getColor(float[] f, boolean fillAndStroke) {
        float c = component(f, 0);
        float m = component(f, 1);
        float y = component(f, 2);
        float k = component(f, 3);

        if (fillAndStroke && c == 0 && m == 0 && y == 0) {
            return DEVICE_GRAY.getColor(new float[] { 1.0f - k });
        }

        float r = 1.0f - Math.min(1.0f, c + k);
        float g = 1.0f - Math.min(1.0f, m + k);
        float b = 1.0f - Math.min(1.0f, y + k);
        return new Color(clamp(r), clamp(g), clamp(b));
    }

    public static ICC_ColorSpace getIccCmykColorSpace() {
        return null;
    }

    public static boolean isDisableICCCmykColorSpace() {
        return disableICCCmykColorSpace;
    }

    public static void setDisableICCCmykColorSpace(boolean disableICCCmykColorSpace) {
        DeviceCMYK.disableICCCmykColorSpace = disableICCCmykColorSpace;
    }

    private static float component(float[] f, int index) {
        return f != null && f.length > index ? clamp(f[index]) : 0;
    }

    private static float clamp(float value) {
        if (value < 0) {
            return 0;
        }
        if (value > 1) {
            return 1;
        }
        return value;
    }
}
EOF

cat > "${PATCH_SRC}/org/icepdf/core/pobjects/graphics/ICCBased.java" <<'EOF'
package org.icepdf.core.pobjects.graphics;

import org.icepdf.core.pobjects.Name;
import org.icepdf.core.pobjects.Stream;
import org.icepdf.core.util.Library;

import java.awt.Color;
import java.awt.color.ColorSpace;

public class ICCBased extends PColorSpace {
    public static final Name ICCBASED_KEY = new Name("ICCBased");
    public static final Name N_KEY = new Name("N");

    private final int numcomp;
    private final PColorSpace alternate;

    public ICCBased(Library l, Stream h) {
        super(l, h.getEntries());
        numcomp = h.getInt(N_KEY);
        switch (numcomp) {
            case 1:
                alternate = new DeviceGray(l, null);
                break;
            case 4:
                alternate = new DeviceCMYK(l, null);
                break;
            case 3:
            default:
                alternate = new DeviceRGB(l, null);
                break;
        }
    }

    public synchronized void init() {
        inited = true;
    }

    public PColorSpace getAlternate() {
        return alternate;
    }

    public Color getColor(float[] f, boolean fillAndStroke) {
        return alternate.getColor(f, fillAndStroke);
    }

    public ColorSpace getColorSpace() {
        return null;
    }

    public int getNumComponents() {
        return numcomp;
    }
}
EOF

cat > "${PATCH_SRC}/org/icepdf/core/pobjects/graphics/ColorSpaceCMYK.java" <<'EOF'
package org.icepdf.core.pobjects.graphics;

import java.awt.color.ColorSpace;

@SuppressWarnings("serial")
public class ColorSpaceCMYK extends ColorSpace {
    private static final String[] NAMES = new String[] { "Cyan", "Magenta", "Yellow", "Black" };

    public ColorSpaceCMYK() {
        super(TYPE_CMYK, 4);
    }

    public int getNumComponents() {
        return 4;
    }

    public String getName(int index) {
        return NAMES[index];
    }

    public int getType() {
        return TYPE_CMYK;
    }

    public boolean isCS_sRGB() {
        return false;
    }

    public float[] fromRGB(float[] rgbValues) {
        float c = 1.0f - component(rgbValues, 0);
        float m = 1.0f - component(rgbValues, 1);
        float y = 1.0f - component(rgbValues, 2);
        float k = Math.min(c, Math.min(m, y));
        return new float[] { clamp(c - k), clamp(m - k), clamp(y - k), clamp(k) };
    }

    public float[] toRGB(float[] cmykValues) {
        float c = component(cmykValues, 0);
        float m = component(cmykValues, 1);
        float y = component(cmykValues, 2);
        float k = component(cmykValues, 3);
        return new float[] {
            1.0f - Math.min(1.0f, c + k),
            1.0f - Math.min(1.0f, m + k),
            1.0f - Math.min(1.0f, y + k)
        };
    }

    public float[] fromCIEXYZ(float[] colorvalue) {
        return fromRGB(colorvalue);
    }

    public float[] toCIEXYZ(float[] colorvalue) {
        return toRGB(colorvalue);
    }

    private static float component(float[] values, int index) {
        return values != null && values.length > index ? clamp(values[index]) : 0;
    }

    private static float clamp(float value) {
        if (value < 0) {
            return 0;
        }
        if (value > 1) {
            return 1;
        }
        return value;
    }
}
EOF

find "${PATCH_SRC}" -name "*.java" -print0 | sort -z \
    | xargs -0 javac --release "${ICEPDF_JAVA_RELEASE}" -encoding UTF-8 \
        -cp "${OUT}/icepdf/icepdf-core.jar" \
        -d "${PATCH_CLASSES}"

jar cf "${OUT}/icepdf/icepdf-cheerpj-patches.jar" -C "${PATCH_CLASSES}" .

cat > "${OUT}/icepdf/icepdf.jars.json" <<'EOF'
{
  "jars": [
    "icepdf-cheerpj-patches.jar",
    "icepdf-core.jar",
    "icepdf-fonts.jar",
    "bcprov-jdk18on.jar",
    "bcpkix-jdk18on.jar",
    "bcutil-jdk18on.jar",
    "imageio-tiff.jar",
    "imageio-core.jar",
    "imageio-metadata.jar",
    "common-lang.jar",
    "common-io.jar",
    "common-image.jar",
    "fontbox.jar",
    "pdfbox-io.jar",
    "commons-logging.jar",
    "jbig2-imageio.jar",
    "jai-imageio-core.jar",
    "jai-imageio-jpeg2000.jar"
  ]
}
EOF

ICEPDF_SOURCE_FINGERPRINT="icepdf=${ICEPDF_VERSION};bouncycastle=${BOUNCYCASTLE_VERSION};twelvemonkeys=${TWELVEMONKEYS_VERSION};pdfbox=${PDFBOX_VERSION};jbig2_imageio=${JBIG2_IMAGEIO_VERSION};jai_imageio_core=${JAI_IMAGEIO_CORE_VERSION};jai_imageio_jpeg2000=${JAI_IMAGEIO_JPEG2000_VERSION};commons_logging=${COMMONS_LOGGING_VERSION}"

cat > "${OUT}/icepdf/source.json" <<EOF
{
  "name": "icepdf",
  "version": "${ICEPDF_VERSION}",
  "dependencies": {
    "bouncycastle": "${BOUNCYCASTLE_VERSION}",
    "twelvemonkeys": "${TWELVEMONKEYS_VERSION}",
    "pdfbox": "${PDFBOX_VERSION}",
    "jbig2_imageio": "${JBIG2_IMAGEIO_VERSION}",
    "jai_imageio_core": "${JAI_IMAGEIO_CORE_VERSION}",
    "jai_imageio_jpeg2000": "${JAI_IMAGEIO_JPEG2000_VERSION}",
    "commons_logging": "${COMMONS_LOGGING_VERSION}"
  },
  "fingerprint": "${ICEPDF_SOURCE_FINGERPRINT}"
}
EOF

echo "icepdf: ${OUT}/icepdf ($(du -sh "${OUT}/icepdf" | cut -f1))"
