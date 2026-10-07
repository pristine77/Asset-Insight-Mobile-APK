package com.assetinsight.app

import android.app.Instrumentation
import android.content.res.Configuration
import android.graphics.Rect
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import expo.modules.auctioncamera.R

/** Offline real-resource checks, without opening a camera or customer draft. */
object CameraLayoutAssertions {
    @JvmStatic fun run(instrumentation: Instrumentation) {
        instrumentation.runOnMainSync {
            for (font in listOf(1f, 1.3f, 2f)) {
                for ((width, height) in listOf(800 to 360, 640 to 320, 360 to 800)) {
                    val config = Configuration(instrumentation.targetContext.resources.configuration).apply {
                        fontScale = font
                        screenWidthDp = width
                        screenHeightDp = height
                        smallestScreenWidthDp = minOf(width, height)
                        orientation = if (width > height) Configuration.ORIENTATION_LANDSCAPE
                            else Configuration.ORIENTATION_PORTRAIT
                    }
                    val context = ContextThemeWrapper(
                        instrumentation.targetContext.createConfigurationContext(config),
                        R.style.Theme_MyAndroidTemplate
                    )
                    val density = context.resources.displayMetrics.density
                    val root = LayoutInflater.from(context).inflate(R.layout.activity_camera_view, null) as ViewGroup
                    val w = (width * density).toInt()
                    val h = (height * density).toInt()
                    root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                    root.layout(0, 0, w, h)
                    val done = root.findViewById<View>(R.id.textViewDone)
                    val record = root.findViewById<View>(R.id.imageViewRecordVideo)
                    check(done.measuredHeight > 0 && record.measuredHeight > 0)
                    if (width > height) {
                        val scroll = root.findViewById<ScrollView>(R.id.rightPanelScroll)
                        check(scroll.isVerticalScrollBarEnabled && !scroll.isScrollbarFadingEnabled)
                        scroll.scrollTo(0, scroll.getChildAt(0).height)
                        val bounds = Rect(0, 0, done.width, done.height)
                        root.offsetDescendantRectToMyCoords(done, bounds)
                        check(bounds.top >= 0 && bounds.bottom <= h) { "Done unreachable: $bounds in height $h" }
                        scroll.scrollTo(0, 0)
                        val recordBounds = Rect(0, 0, record.width, record.height)
                        root.offsetDescendantRectToMyCoords(record, recordBounds)
                        check(recordBounds.top >= 0 && recordBounds.bottom <= h) { "Record unreachable" }
                    }
                }
            }
        }
    }
}
