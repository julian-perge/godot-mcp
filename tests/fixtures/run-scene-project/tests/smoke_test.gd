extends Node


func _ready() -> void:
	print("RUN_SCENE_TEST_OK")
	print("RUN_SCENE_USER_ARGS ", OS.get_cmdline_user_args())
	print("RUN_SCENE_DISPLAY ", DisplayServer.get_name())
