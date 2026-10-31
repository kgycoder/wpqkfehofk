package com.sync.app.glass

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.colorControls
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.highlight.Highlight
import com.kyant.shapes.RoundedRectangle
import kotlinx.coroutines.delay

/** 휴지통 아이콘 (viewBox 20, 다른 GlassIcons 와 같은 선 스타일) */
private val TrashIcon: List<Path> by lazy {
    fun p(d: String): Path = PathParser().parsePathString(d).toPath()
    listOf(
        p("M3.5 5.5h13"),
        p("M8 5.5V4a1.2 1.2 0 0 1 1.2-1.2h1.6A1.2 1.2 0 0 1 12 4v1.5"),
        p("M5.2 5.5l.8 10.1a1.5 1.5 0 0 0 1.5 1.4h5a1.5 1.5 0 0 0 1.5-1.4l.8-10.1"),
        p("M8.3 9v5"),
        p("M11.7 9v5")
    )
}

/** Kyant `DialogContent` 와 같은 유리 설정(colorControls + blur + lens + plain highlight). 등장/퇴장은 pop 값으로 구동. */
private fun Modifier.trackMenuGlass(backdrop: Backdrop, pop: Float, above: Boolean): Modifier =
    this.drawBackdrop(
        backdrop = backdrop,
        shape = { RoundedRectangle(26.dp) },
        effects = {
            colorControls(brightness = 0f, saturation = 1.5f)
            blur(3f.dp.toPx())
            lens(16f.dp.toPx(), 32f.dp.toPx(), depthEffect = true)
        },
        highlight = { Highlight.Plain },
        layerBlock = {
            val p = pop.coerceIn(0f, 1.2f)
            val s = lerp(0.82f, 1f, p)
            scaleX = s; scaleY = s
            alpha = p.coerceIn(0f, 1f)
            // 메뉴가 행에 "붙어서" 펼쳐지는 느낌: 행 쪽 모서리를 기준으로 커진다
            transformOrigin = TransformOrigin(0.85f, if (above) 1f else 0f)
        },
        onDrawSurface = { drawRect(GlassTheme.Container) }
    )

private val SwallowTap: Modifier = Modifier.pointerInput(Unit) {
    // 메뉴 표면에서의 탭이 뒤의 DOM(= edit 종료 click)으로 새지 않도록 소비
    detectTapGestures { }
}

/**
 * 플레이리스트 곡 edit 상태의 컨텍스트 메뉴 (곡 즐겨찾기 / 곡 삭제).
 * 드래그 중에는 부드럽게 사라졌다가 놓으면 새 위치에서 다시 펼쳐진다. edit 가 끝나면(closing) 페이드 아웃.
 */
@Composable
internal fun TrackEditMenuGlass(te: TrackEditState, backdrop: Backdrop, c: GlassController) {
    val show = !te.dragging && !te.closing
    val pop = remember { Animatable(0f) }
    LaunchedEffect(show) {
        if (show) {
            delay(60)                                    // 행이 커지는 동작 뒤에 이어서 등장
            pop.animateTo(1f, spring(0.72f, 420f, 0.001f))
        } else {
            pop.animateTo(0f, tween(130))
        }
    }
    val p = pop.value
    if (p <= 0.002f) return                              // 완전히 숨겨진 동안은 터치도 받지 않는다

    val m = te.menuRect()
    val above = m.y < te.rect.y
    val accent = LocalGlassAccent.current

    Box(Modifier.cssRect(m)) {
        Column(
            Modifier
                .fillMaxSize()
                .trackMenuGlass(backdrop, p, above)
                .then(SwallowTap)
                .padding(vertical = 6.dp)
        ) {
            EditMenuItem(
                label = te.favLabel, color = GlassTheme.Content,
                icon = {
                    Canvas(Modifier.size(20.dp)) {
                        if (te.fav) fillIcon(GlassIcons.Fav[0], 20f, accent)
                        else strokeIcon(GlassIcons.Fav, 20f, GlassTheme.Content, 1.6f)
                    }
                }
            ) { c.cmd { put("t", "tedit"); put("a", "fav") } }

            Box(
                Modifier.padding(horizontal = 18.dp).fillMaxWidth().height(0.5.dp)
                    .background(Color.White.copy(0.18f))
            )

            EditMenuItem(
                label = te.delLabel, color = GlassTheme.Danger,
                icon = { Canvas(Modifier.size(20.dp)) { strokeIcon(TrashIcon, 20f, GlassTheme.Danger, 1.6f) } }
            ) { c.cmd { put("t", "tedit"); put("a", "del") } }
        }
    }
}

@Composable
private fun EditMenuItem(label: String, color: Color, icon: @Composable () -> Unit, onClick: () -> Unit) {
    var pressed by remember { mutableStateOf(false) }
    val press by animateFloatAsState(if (pressed) 1f else 0f, tween(110), label = "trackMenuPress")
    val click by rememberUpdatedState(onClick)
    Row(
        Modifier
            .fillMaxWidth()
            .height(50.dp)
            .padding(horizontal = 6.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(Color.White.copy(0.14f * press))
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = { pressed = true; tryAwaitRelease(); pressed = false },
                    onTap = { click() }
                )
            }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) { icon() }
        Spacer(Modifier.width(12.dp))
        BasicText(
            label, maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = TextStyle(color, 15.sp, FontWeight.Medium)
        )
    }
}
