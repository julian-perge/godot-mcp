extends SceneTree
## godot-mcp harness. When run_project or run_scene starts a game, the server
## passes this script to Godot with -s, so it runs as the game's main loop and
## nothing is installed into the project. The project's autoloads and scene load
## as usual, and the harness adds a TCP endpoint on 127.0.0.1 that
## capture_screenshot and simulate_input talk to.
##
## The endpoint only opens in a debug build and only when the server set
## GODOT_MCP_HARNESS_PORT and GODOT_MCP_HARNESS_TOKEN. Each request is one line
## of JSON carrying that token, and the answer is one line of JSON. The harness
## never writes files. Screenshots go back over the socket as base64 PNG.
##
## Screenshots and input positions are in the root viewport's own coordinates,
## the ones node positions use. Under stretch mode canvas_items or viewport that
## is the base size from the project settings, whatever the window size or
## screen density, so a pixel in a screenshot is the position that clicks it.

const HOST := "127.0.0.1"
const MAX_REQUEST_BYTES := 1048576
const LOG_PREFIX := "[godot-mcp harness] "
const MOUSE_BUTTONS := {
	"left": MOUSE_BUTTON_LEFT,
	"right": MOUSE_BUTTON_RIGHT,
	"middle": MOUSE_BUTTON_MIDDLE,
}
const MODIFIERS := ["shift", "ctrl", "alt", "meta"]
# Key names the original input PR accepted that Godot spells differently.
const KEY_ALIASES := {
	" ": "Space",
	"return": "Enter",
	"esc": "Escape",
	"del": "Delete",
	"control": "Ctrl",
}
const CLICK_HOLD_SEC := 0.05
const KEY_HOLD_SEC := 0.05
const TEXT_HOLD_SEC := 0.02
const DRAG_STEPS := 10
const DRAG_STEP_SEC := 0.01
const DEFAULT_DURATION_MS := 100
const DEFAULT_TEXT_DELAY_MS := 50
const FRAME_WAIT_MSEC := 3000
const NO_FRAME_ERROR := "the game window drew no frame, so it is probably hidden, minimized or covered"


class Client:
	var peer: StreamPeerTCP
	var buffer := PackedByteArray()


var _server: TCPServer = null
var _token := ""
var _clients: Array[Client] = []
# Requests run one at a time. While this client's request runs, the others
# stay unread in their sockets.
var _active: Client = null
# The last injected mouse position in viewport coordinates, and the injected
# buttons that are still held, so motion events carry the same state as real ones.
var _mouse_position := Vector2.ZERO
var _mouse_buttons := 0


func _initialize() -> void:
	# Godot loads the main scene by itself only when no -s script is given.
	if current_scene == null:
		var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if not main_scene.is_empty():
			change_scene_to_file(main_scene)
	if not OS.is_debug_build():
		return
	var port := OS.get_environment("GODOT_MCP_HARNESS_PORT").to_int()
	_token = OS.get_environment("GODOT_MCP_HARNESS_TOKEN")
	if port <= 0 or _token.is_empty():
		return
	_server = TCPServer.new()
	var err := _server.listen(port, HOST)
	if err != OK:
		push_warning(LOG_PREFIX + "could not listen on %s:%d (error %d)" % [HOST, port, err])
		_server = null
		return
	print(LOG_PREFIX + "listening on %s:%d" % [HOST, port])


func _finalize() -> void:
	if _server != null:
		_server.stop()
	for client in _clients:
		client.peer.disconnect_from_host()
	_clients.clear()


func _process(_delta: float) -> bool:
	if _server == null:
		return false
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			var client := Client.new()
			client.peer = peer
			_clients.append(client)
	for client in _clients.duplicate():
		_poll_client(client)
	return false


func _poll_client(client: Client) -> void:
	client.peer.poll()
	var status := client.peer.get_status()
	if status != StreamPeerTCP.STATUS_CONNECTED:
		if status != StreamPeerTCP.STATUS_CONNECTING:
			_clients.erase(client)
			# The server has stopped waiting for this request, so a command that
			# is still running must not hold up the next one.
			if _active == client:
				_active = null
		return
	if _active != null:
		return
	var available := client.peer.get_available_bytes()
	if available <= 0:
		return
	var chunk := client.peer.get_data(available)
	if chunk[0] != OK:
		return
	client.buffer = client.buffer + chunk[1]
	var newline := client.buffer.find(10)
	if newline == -1:
		if client.buffer.size() > MAX_REQUEST_BYTES:
			_respond(client, {"ok": false, "error": "request too large"})
		return
	_active = client
	_handle_request(client, client.buffer.slice(0, newline).get_string_from_utf8())


func _handle_request(client: Client, line: String) -> void:
	var request = JSON.parse_string(line)
	var response: Dictionary
	if typeof(request) != TYPE_DICTIONARY:
		response = {"ok": false, "error": "request is not a JSON object"}
	elif str(request.get("token", "")) != _token:
		response = {"ok": false, "error": "bad token"}
	elif typeof(request.get("commands")) != TYPE_ARRAY:
		response = {"ok": false, "error": "request has no commands array"}
	else:
		var warp = request.get("warp_mouse", false)
		response = await _run_commands(client, request.commands, typeof(warp) == TYPE_BOOL and warp)
	_respond(client, response)


func _respond(client: Client, response: Dictionary) -> void:
	if client.peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		client.peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())
	client.peer.disconnect_from_host()
	_clients.erase(client)
	if _active == client:
		_active = null


# Runs the commands in order and stops at the first one that fails, so a
# failed step never leaves the game in a state later steps did not expect. It
# also stops once the server has stopped waiting and closed the connection, so
# a timed-out sequence does not keep sending input into the next one.
func _run_commands(client: Client, commands: Array, warp: bool) -> Dictionary:
	var results := []
	for command in commands:
		client.peer.poll()
		if client.peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			return {"ok": false, "error": "the server closed the connection", "results": results}
		var result: Dictionary
		if typeof(command) != TYPE_DICTIONARY:
			result = {"error": "each command must be a JSON object"}
		else:
			result = await _run_command(client, command, warp)
			result["type"] = str(command.get("type", ""))
		results.append(result)
		if result.has("error"):
			return {"ok": false, "results": results}
	return {"ok": true, "results": results}


func _run_command(client: Client, command: Dictionary, warp: bool) -> Dictionary:
	match str(command.get("type", "")):
		"screenshot":
			return await _screenshot()
		"click":
			return await _click(command, warp)
		"mouse_move":
			return _mouse_move(command, warp)
		"mouse_drag":
			return await _mouse_drag(command, warp)
		"key":
			return await _key(command)
		"action":
			return _action(command)
		"action_pulse":
			return await _action_pulse(command)
		"text":
			return await _text(client, command)
		"wait":
			return await _wait(command)
		var other:
			return {"error": "unknown command type: %s" % other}


func _screenshot() -> Dictionary:
	# The headless display server never draws a frame, so waiting for one would hang.
	if DisplayServer.get_name() == "headless":
		return {"error": "the game runs headless, so it draws nothing to capture"}
	# Godot stops drawing a window that is minimized or fully covered, and the
	# window reports that, so the request can fail at once.
	if not DisplayServer.window_can_draw():
		return {"error": NO_FRAME_ERROR}
	if not await _wait_for_drawn_frame():
		return {"error": NO_FRAME_ERROR}
	var image := root.get_texture().get_image()
	if image == null or image.is_empty():
		return {"error": "the viewport returned no image"}
	# The texture shows exactly the visible rect, letterbox bars excluded, but
	# under stretch mode canvas_items it has the window's pixel size times the
	# screen scale. Scaling it to the rect's size puts it in node coordinates.
	var size := Vector2i(root.get_visible_rect().size.round())
	if image.get_size() != size:
		image.resize(size.x, size.y, Image.INTERPOLATE_LANCZOS)
	return {
		"width": image.get_width(),
		"height": image.get_height(),
		"png_base64": Marshalls.raw_to_base64(image.save_png_to_buffer()),
	}


# Waits for the next drawn frame, because the viewport texture is only complete
# once a frame has been drawn, and returns false if none comes before the
# deadline. Awaiting frame_post_draw would never return when drawing is skipped,
# but process frames keep running then, so this loop always reaches the deadline.
func _wait_for_drawn_frame() -> bool:
	var frames_drawn := Engine.get_frames_drawn()
	var deadline := Time.get_ticks_msec() + FRAME_WAIT_MSEC
	while Engine.get_frames_drawn() == frames_drawn:
		if Time.get_ticks_msec() >= deadline:
			return false
		await process_frame
	return true


func _click(command: Dictionary, warp: bool) -> Dictionary:
	var pos = _read_point(command, "x", "y")
	if pos is Dictionary:
		return pos
	var button = _read_button(command)
	if button is Dictionary:
		return button
	var double = command.get("double", false)
	if typeof(double) != TYPE_BOOL:
		return {"error": "double must be true or false"}
	_send_motion(pos, warp)
	_send_button(pos, button, true)
	await _sleep(CLICK_HOLD_SEC)
	_send_button(pos, button, false)
	if double:
		await _sleep(CLICK_HOLD_SEC)
		_send_button(pos, button, true, true)
		await _sleep(CLICK_HOLD_SEC)
		_send_button(pos, button, false)
	return {}


func _mouse_move(command: Dictionary, warp: bool) -> Dictionary:
	var pos = _read_point(command, "x", "y")
	if pos is Dictionary:
		return pos
	_send_motion(pos, warp)
	return {}


func _mouse_drag(command: Dictionary, warp: bool) -> Dictionary:
	var start = _read_point(command, "from_x", "from_y")
	if start is Dictionary:
		return start
	var end = _read_point(command, "to_x", "to_y")
	if end is Dictionary:
		return end
	var button = _read_button(command)
	if button is Dictionary:
		return button
	_send_motion(start, warp)
	_send_button(start, button, true)
	for step in range(1, DRAG_STEPS + 1):
		await _sleep(DRAG_STEP_SEC)
		_send_motion(start.lerp(end, float(step) / DRAG_STEPS), warp)
	_send_button(end, button, false)
	return {}


func _key(command: Dictionary) -> Dictionary:
	var keycode = _read_key(command)
	if keycode is Dictionary:
		return keycode
	var modifiers = _read_modifiers(command)
	if modifiers is Dictionary:
		return modifiers
	var key: Key = keycode & KEY_CODE_MASK
	var event := InputEventKey.new()
	event.keycode = key
	event.physical_keycode = key
	event.key_label = key
	event.shift_pressed = "shift" in modifiers or (keycode & KEY_MASK_SHIFT) != 0
	event.ctrl_pressed = "ctrl" in modifiers or (keycode & KEY_MASK_CTRL) != 0
	event.alt_pressed = "alt" in modifiers or (keycode & KEY_MASK_ALT) != 0
	event.meta_pressed = "meta" in modifiers or (keycode & KEY_MASK_META) != 0
	event.pressed = true
	Input.parse_input_event(event)
	await _sleep(KEY_HOLD_SEC)
	var release: InputEventKey = event.duplicate()
	release.pressed = false
	Input.parse_input_event(release)
	return {}


func _action(command: Dictionary) -> Dictionary:
	var action = _read_action(command)
	if action is Dictionary:
		return action
	var pressed = command.get("pressed", true)
	if typeof(pressed) != TYPE_BOOL:
		return {"error": "pressed must be true or false"}
	_send_action(action, pressed)
	return {}


func _action_pulse(command: Dictionary) -> Dictionary:
	var action = _read_action(command)
	if action is Dictionary:
		return action
	var duration = _read_seconds(command, "duration_ms", DEFAULT_DURATION_MS)
	if duration is Dictionary:
		return duration
	_send_action(action, true)
	await _sleep(duration)
	_send_action(action, false)
	return {}


func _text(client: Client, command: Dictionary) -> Dictionary:
	var text = command.get("text")
	if typeof(text) != TYPE_STRING:
		return {"error": "text needs a string text"}
	var delay = _read_seconds(command, "delay_ms", DEFAULT_TEXT_DELAY_MS)
	if delay is Dictionary:
		return delay
	for character in text:
		# A dropped request has already handed the game to the next one, so the
		# rest of its text must not be typed into that one.
		if _active != client:
			return {"error": "the server closed the connection"}
		var key := _character_key(character)
		var code: int = character.unicode_at(0)
		var event := InputEventKey.new()
		event.keycode = key
		event.physical_keycode = key
		event.key_label = key
		# Controls insert printable characters from unicode. Enter and Tab act
		# through their keycode alone, as they do on a real keyboard.
		event.unicode = code if code >= 32 else 0
		event.shift_pressed = character != character.to_lower()
		event.pressed = true
		Input.parse_input_event(event)
		await _sleep(TEXT_HOLD_SEC)
		var release: InputEventKey = event.duplicate()
		release.pressed = false
		Input.parse_input_event(release)
		await _sleep(delay)
	return {}


func _wait(command: Dictionary) -> Dictionary:
	var duration = _read_seconds(command, "duration_ms", DEFAULT_DURATION_MS)
	if duration is Dictionary:
		return duration
	await _sleep(duration)
	return {}


# Moves the mouse to pos, given in viewport coordinates. Input events carry
# window coordinates, and the screen transform maps one to the other.
func _send_motion(pos: Vector2, warp: bool) -> void:
	var screen := root.get_screen_transform()
	if warp:
		root.warp_mouse(pos)
	var event := InputEventMouseMotion.new()
	event.position = screen * pos
	event.global_position = event.position
	event.relative = screen.basis_xform(pos - _mouse_position)
	event.button_mask = _mouse_buttons
	Input.parse_input_event(event)
	_mouse_position = pos


func _send_button(pos: Vector2, button: MouseButton, pressed: bool, double_click := false) -> void:
	var bit := 1 << (button - 1)
	if pressed:
		_mouse_buttons |= bit
	else:
		_mouse_buttons &= ~bit
	var event := InputEventMouseButton.new()
	event.position = root.get_screen_transform() * pos
	event.global_position = event.position
	event.button_index = button
	event.button_mask = _mouse_buttons
	event.pressed = pressed
	event.double_click = double_click
	Input.parse_input_event(event)


func _send_action(action: String, pressed: bool) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = 1.0 if pressed else 0.0
	Input.parse_input_event(event)


# Waits in real time, also while the game is paused or Engine.time_scale is 0.
func _sleep(seconds: float) -> void:
	await create_timer(seconds, true, false, true).timeout


func _read_point(command: Dictionary, x_key: String, y_key: String) -> Variant:
	var x = command.get(x_key)
	var y = command.get(y_key)
	if not _is_number(x) or not _is_number(y):
		return {"error": "%s needs numbers %s and %s" % [str(command.get("type")), x_key, y_key]}
	return Vector2(x, y)


func _read_button(command: Dictionary) -> Variant:
	var name = command.get("button", "left")
	if typeof(name) != TYPE_STRING or not MOUSE_BUTTONS.has(name):
		return {"error": "button must be left, right or middle"}
	return MOUSE_BUTTONS[name]


# Returns the keycode with any modifiers written into the name, such as
# "Ctrl+S", left in its modifier bits.
func _read_key(command: Dictionary) -> Variant:
	var name = command.get("key")
	if typeof(name) != TYPE_STRING or name.is_empty():
		return {"error": "key needs a Godot key name such as A, Space, Enter, Escape, Up or F5"}
	var keycode: int = OS.find_keycode_from_string(KEY_ALIASES.get(name.to_lower(), name))
	if (keycode & KEY_CODE_MASK) == KEY_NONE:
		return {"error": "unknown key: %s" % name}
	return keycode


func _read_modifiers(command: Dictionary) -> Variant:
	var modifiers = command.get("modifiers", [])
	if typeof(modifiers) != TYPE_ARRAY:
		return {"error": "modifiers must be a list such as [\"ctrl\", \"shift\"]"}
	for modifier in modifiers:
		if typeof(modifier) != TYPE_STRING or not (modifier in MODIFIERS):
			return {"error": "unknown modifier: %s, use shift, ctrl, alt or meta" % str(modifier)}
	return modifiers


func _read_action(command: Dictionary) -> Variant:
	var action = command.get("action")
	if typeof(action) != TYPE_STRING or not InputMap.has_action(action):
		return {"error": "unknown input action: %s" % str(action)}
	return action


func _read_seconds(command: Dictionary, key: String, default_ms: float) -> Variant:
	var value = command.get(key, default_ms)
	if not _is_number(value) or value < 0:
		return {"error": "%s must be a number of milliseconds, 0 or more" % key}
	return float(value) / 1000.0


# Godot names letters and digits by the character itself, so those resolve
# directly. Other punctuation gets no keycode and arrives through unicode.
func _character_key(character: String) -> Key:
	match character:
		" ":
			return KEY_SPACE
		"\n":
			return KEY_ENTER
		"\t":
			return KEY_TAB
	return OS.find_keycode_from_string(character)


func _is_number(value) -> bool:
	return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT
